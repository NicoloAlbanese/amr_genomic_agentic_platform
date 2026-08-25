import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

export interface FrontendStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
  /** WAF WebACL ARN — must be in us-east-1 (passed from WafStack or SSM lookup) */
  webAclArn: string;
  /** Cognito + API values (from ApiStack) used to generate the SPA runtime config. */
  userPoolId: string;
  userPoolClientId: string;
  cognitoDomainUrl: string;
  restApiUrl: string;
  wsApiUrl: string;
  /** Lambda logs CMK ARN (from FoundationStack) for the callback-updater log group. */
  lambdaLogsCmkArn: string;
}

export class FrontendStack extends cdk.Stack {
  public readonly distributionUrl: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);

    const prefix = props.resourcePrefix;

    // ---------------------------------------------------------
    // S3 Bucket — private, SSE-S3, no public access
    // ---------------------------------------------------------
    const bucket = new s3.Bucket(this, 'FrontendBucket', {
      bucketName: `${prefix}-amr-frontend`,
      // CRITICAL: Block all public access
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // No versioning needed for static SPA assets
      versioned: false,
    });

    // ---------------------------------------------------------
    // CloudFront Origin Access Control (OAC)
    // OAC is the modern replacement for OAI — uses sigv4 signing
    // ---------------------------------------------------------
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: {
        name: `${prefix}-amr-frontend-oac`,
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    // Cache policies
    const cachingDisabled = cloudfront.CachePolicy.CACHING_DISABLED;
    const cachingOptimized = cloudfront.CachePolicy.CACHING_OPTIMIZED;

    // ---------------------------------------------------------
    // CloudFront Distribution
    // ---------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${prefix} AMR Frontend`,
      // Security: require TLS 1.2 minimum
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // WAF
      webAclId: props.webAclArn,
      defaultBehavior: {
        // S3 origin — OAC handles auth via bucket policy (automatically configured by CDK)
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        // Root / uses no cache (HTML must always be fresh for SPA routing)
        cachePolicy: cachingDisabled,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      },
      additionalBehaviors: {
        // /assets/* can be cached aggressively (content-hashed filenames)
        '/assets/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
          cachePolicy: cachingOptimized,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
      },
      // SPA routing: 403/404 from S3 → serve index.html with 200
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      defaultRootObject: 'index.html',
      // Enable IPv6
      enableIpv6: true,
    });

    // ---------------------------------------------------------
    // Bucket policy: allow CloudFront OAC to read objects
    // This replaces the OAI approach — must be done via raw L1
    // because CDK's S3BucketOrigin.withOriginAccessControl adds
    // the policy automatically. We verify it here.
    // ---------------------------------------------------------
    // The above S3BucketOrigin.withOriginAccessControl() call
    // automatically creates the bucket policy grant. No manual
    // bucket policy needed.

    const distributionDomainName = distribution.distributionDomainName;
    const cloudfrontUrl = `https://${distributionDomainName}`;

    // ---------------------------------------------------------
    // Runtime configuration for the SPA.
    // The bundle is account-agnostic and fetches /runtime-config.json at startup.
    // We generate that file here from the real API/Cognito values plus the
    // CloudFront URL (a deploy-time token), so no rebuild is needed per account.
    // Source.jsonData resolves CFN tokens at deploy time.
    // ---------------------------------------------------------
    const runtimeConfig = {
      VITE_REGION: this.region,
      VITE_USER_POOL_ID: props.userPoolId,
      VITE_USER_POOL_CLIENT_ID: props.userPoolClientId,
      VITE_COGNITO_DOMAIN: props.cognitoDomainUrl,
      VITE_REST_API_URL: props.restApiUrl,
      VITE_WS_API_URL: props.wsApiUrl,
      VITE_CLOUDFRONT_URL: cloudfrontUrl,
    };

    // ---------------------------------------------------------
    // Deploy dist/ to S3 and invalidate CloudFront.
    // Two sources: the built SPA assets, and the generated runtime-config.json.
    // ---------------------------------------------------------
    new s3deploy.BucketDeployment(this, 'DeployFrontend', {
      sources: [
        s3deploy.Source.asset(
          path.join(__dirname, '..', '..', 'frontend', 'dist'),
        ),
        s3deploy.Source.jsonData('runtime-config.json', runtimeConfig),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      // Use memory-efficient settings for large bundles
      memoryLimit: 512,
      // Set cache headers for HTML (no-cache) and assets (1 year)
      cacheControl: [
        s3deploy.CacheControl.fromString('no-cache, no-store, must-revalidate'),
      ],
      prune: true,
    });

    // ---------------------------------------------------------
    // Register the CloudFront URL as an allowed Cognito OAuth callback/logout URL.
    // The user pool client is created in the API stack, but the CloudFront domain
    // is only known here, so a small read-modify-write custom resource merges the
    // URLs into the existing client without clobbering its other settings.
    // ---------------------------------------------------------
    const lambdaLogsCmk = kms.Key.fromKeyArn(this, 'LambdaLogsCmk', props.lambdaLogsCmkArn);
    const callbackUpdaterLogs = new logs.LogGroup(this, 'CognitoCallbackUpdaterLogs', {
      logGroupName: `/aws/lambda/${prefix}-amr-cognito-callback-updater`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: lambdaLogsCmk,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const callbackUpdaterFn = new lambdaNodejs.NodejsFunction(this, 'CognitoCallbackUpdaterFn', {
      functionName: `${prefix}-amr-cognito-callback-updater`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'src', 'api', 'cognito-callback-updater.ts'),
      handler: 'handler',
      projectRoot: path.join(__dirname, '..', '..'),
      depsLockFilePath: path.join(__dirname, '..', '..', 'package-lock.json'),
      bundling: {
        minify: false,
        sourceMap: false,
        externalModules: ['@aws-sdk/*'],
        esbuildArgs: { '--platform': 'node', '--target': 'node22' },
      },
      timeout: cdk.Duration.minutes(1),
      memorySize: 256,
      logGroup: callbackUpdaterLogs,
    });
    callbackUpdaterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:DescribeUserPoolClient', 'cognito-idp:UpdateUserPoolClient'],
        resources: [
          `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`,
        ],
      }),
    );

    const callbackUpdaterProvider = new cr.Provider(this, 'CognitoCallbackUpdaterProvider', {
      onEventHandler: callbackUpdaterFn,
    });

    new cdk.CustomResource(this, 'CognitoCallbackUpdater', {
      serviceToken: callbackUpdaterProvider.serviceToken,
      properties: {
        UserPoolId: props.userPoolId,
        ClientId: props.userPoolClientId,
        CallbackUrls: [`${cloudfrontUrl}/callback`],
        LogoutUrls: [cloudfrontUrl],
        // Change this to force the custom resource to re-run when URLs change.
        Version: cloudfrontUrl,
      },
    });

    // ---------------------------------------------------------
    // SSM: store distribution domain for other stacks / scripts
    // ---------------------------------------------------------
    this.distributionUrl = cloudfrontUrl;

    new ssm.StringParameter(this, 'DistributionDomainParam', {
      parameterName: `/${prefix}/amr/cloudfront/domain`,
      stringValue: distributionDomainName,
      description: `${prefix} AMR CloudFront distribution domain`,
    });

    // ---------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------
    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
      exportName: `${prefix}-amr-cloudfront-domain`,
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: cloudfrontUrl,
      description: 'CloudFront distribution URL (HTTPS)',
      exportName: `${prefix}-amr-cloudfront-url`,
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: bucket.bucketName,
      description: 'Frontend S3 bucket name',
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });
  }
}
