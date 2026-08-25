import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecrdeploy from 'cdk-ecr-deployment';
import { Construct } from 'constructs';

export interface ContainersStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
  /** ARN of the HealthOmics CMK, passed from the foundation stack via env var or literal ARN */
  healthOmicsCmkArn: string;
}

/**
 * ContainersStack — ECR repositories + bioinformatics Docker images.
 *
 * Creates 5 ECR repos (imageScanOnPush=true, IMMUTABLE, KMS-encrypted):
 *  1. amr-sra-tools       — NCBI sra-tools (fasterq-dump)
 *  2. amr-fastp-skesa     — fastp + SKESA multi-stage image
 *  3. amr-funcscan        — AMR screening tools (rgi, resfinder)
 *  4. amr-hamronization   — hAMRonization 1.x
 *  5. amr-agent-runtime   — arm64 Strands Agents + boto3 (AgentCore Runtime)
 *
 * Addresses: FR-019, NFR-009
 */
export class ContainersStack extends cdk.Stack {
  /** Public props for cross-stack reference */
  public readonly repoArns: Record<string, string>;
  public readonly imageUris: Record<string, string>;

  constructor(scope: Construct, id: string, props: ContainersStackProps) {
    super(scope, id, props);

    const { resourcePrefix, runId, healthOmicsCmkArn } = props;
    const paramNamespace = `/${resourcePrefix}/amr`;

    // ─── KMS key ─────────────────────────────────────────────────────────────
    // Import the HealthOmics CMK ARN passed in as a prop from app.ts.
    const ecrKmsKey = kms.Key.fromKeyArn(this, 'EcrKmsKey', healthOmicsCmkArn);

    // ─── Helper: create an ECR repository ────────────────────────────────────
    const createRepo = (name: string, repoNameSuffix: string): ecr.Repository => {
      const repo = new ecr.Repository(this, `${name}-repo`, {
        repositoryName: `${resourcePrefix}-${repoNameSuffix}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryptionKey: ecrKmsKey,
        encryption: ecr.RepositoryEncryption.KMS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      // Allow HealthOmics service principal to pull from this repo
      repo.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowHealthOmicsPull',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('omics.amazonaws.com')],
          actions: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
          ],
          conditions: {
            // Constrain to this account to prevent confused deputy (ECR runbook Pattern 12)
            StringEquals: { 'aws:SourceAccount': this.account },
          },
        }),
      );

      // Lifecycle policy: expire untagged images quickly, keep last 10 run-tagged
      repo.addLifecycleRule({
        description: 'Expire untagged images after 1 day',
        tagStatus: ecr.TagStatus.UNTAGGED,
        maxImageAge: cdk.Duration.days(1),
      });
      repo.addLifecycleRule({
        description: 'Keep last 10 tagged images',
        tagStatus: ecr.TagStatus.TAGGED,
        tagPrefixList: ['run-'],
        maxImageCount: 10,
      });

      return repo;
    };

    // ─── Create the 5 ECR repos ───────────────────────────────────────────────
    const sraToolsRepo = createRepo('SraTools', 'amr-sra-tools');
    const fastpSkesaRepo = createRepo('FastpSkesa', 'amr-fastp-skesa');
    const funcscanRepo = createRepo('Funcscan', 'amr-funcscan');
    const hamronizationRepo = createRepo('Hamronization', 'amr-hamronization');
    const agentRuntimeRepo = createRepo('AgentRuntime', 'amr-agent-runtime');

    // ─── Build Docker images via CDK DockerImageAsset ─────────────────────────
    // Per cdk-bundling-assets runbook Pattern 2: always pass `platform` so
    // the asset hash includes the target architecture, preventing wrong-arch reuse.

    const srcContainersDir = path.join(__dirname, '../../src/containers');

    const sraToolsImage = new assets.DockerImageAsset(this, 'SraToolsImage', {
      directory: path.join(srcContainersDir, 'sra-tools'),
      platform: assets.Platform.LINUX_AMD64,
      buildArgs: { IMAGE_TAG: runId },
    });

    const fastpSkesaImage = new assets.DockerImageAsset(this, 'FastpSkesaImage', {
      directory: path.join(srcContainersDir, 'fastp-skesa'),
      platform: assets.Platform.LINUX_AMD64,
      buildArgs: { IMAGE_TAG: runId },
    });

    const funcscanImage = new assets.DockerImageAsset(this, 'FuncscanImage', {
      directory: path.join(srcContainersDir, 'funcscan'),
      platform: assets.Platform.LINUX_AMD64,
      buildArgs: { IMAGE_TAG: runId },
    });

    const hamronizationImage = new assets.DockerImageAsset(this, 'HamronizationImage', {
      directory: path.join(srcContainersDir, 'hamronization'),
      platform: assets.Platform.LINUX_AMD64,
      buildArgs: { IMAGE_TAG: runId },
    });

    // agent-runtime: arm64 ONLY — AgentCore Runtime strictly requires linux/arm64
    // (bedrock-agentcore-runtime runbook Pattern 1)
    const agentRuntimeImage = new assets.DockerImageAsset(this, 'AgentRuntimeImage', {
      directory: path.join(srcContainersDir, 'agent-runtime'),
      platform: assets.Platform.LINUX_ARM64,
      buildArgs: { IMAGE_TAG: runId },
    });

    // ─── Copy HealthOmics workflow images into their dedicated repos ──────────
    // DockerImageAsset publishes to the shared CDK bootstrap assets repo, which
    // does NOT carry the omics.amazonaws.com pull policy that HealthOmics
    // requires. The dedicated fastp-skesa and funcscan repos (created above with
    // that resource policy and the HealthOmics CMK) are the ones HealthOmics can
    // pull from. Copy the built images into them so the AMR workflow can run.
    // Repos are IMMUTABLE and keep the last 10 images tagged with a 'run-'
    // prefix, so tag the copy with the run id to avoid overwrite conflicts and
    // match the lifecycle policy.
    const fastpSkesaTargetUri = `${fastpSkesaRepo.repositoryUri}:run-${runId}`;
    const funcscanTargetUri   = `${funcscanRepo.repositoryUri}:run-${runId}`;

    new ecrdeploy.ECRDeployment(this, 'FastpSkesaImageCopy', {
      src: new ecrdeploy.DockerImageName(fastpSkesaImage.imageUri),
      dest: new ecrdeploy.DockerImageName(fastpSkesaTargetUri),
    });
    new ecrdeploy.ECRDeployment(this, 'FuncscanImageCopy', {
      src: new ecrdeploy.DockerImageName(funcscanImage.imageUri),
      dest: new ecrdeploy.DockerImageName(funcscanTargetUri),
    });

    // ─── SSM Parameter Store — store image URIs for downstream stacks ─────────
    const imageParams: Array<{ paramSuffix: string; imageUri: string }> = [
      { paramSuffix: 'sra-tools', imageUri: sraToolsImage.imageUri },
      { paramSuffix: 'fastp-skesa', imageUri: fastpSkesaImage.imageUri },
      { paramSuffix: 'funcscan', imageUri: funcscanImage.imageUri },
      { paramSuffix: 'hamronization', imageUri: hamronizationImage.imageUri },
      { paramSuffix: 'agent-runtime', imageUri: agentRuntimeImage.imageUri },
    ];

    for (const { paramSuffix, imageUri } of imageParams) {
      new ssm.StringParameter(this, `param-ecr-${paramSuffix}`, {
        parameterName: `${paramNamespace}/ecr/image-uri/${paramSuffix}`,
        stringValue: imageUri,
        description: `${resourcePrefix} AMR ECR image URI for ${paramSuffix} (run: ${runId})`,
        tier: ssm.ParameterTier.STANDARD,
      });
    }

    // ─── Store image digests via Lambda custom resource ───────────────────────
    // Collect all 5 repo ARNs for least-privilege IAM scoping
    const allRepoArns = [
      sraToolsRepo.repositoryArn,
      fastpSkesaRepo.repositoryArn,
      funcscanRepo.repositoryArn,
      hamronizationRepo.repositoryArn,
      agentRuntimeRepo.repositoryArn,
    ];

    const digestFetcherRole = new iam.Role(this, 'DigestFetcherRole', {
      roleName: `${resourcePrefix}-amr-digest-fetcher`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        ecrAndSsmAccess: new iam.PolicyDocument({
          statements: [
            // ecr:GetAuthorizationToken is a registry-level action, must be Resource: *
            new iam.PolicyStatement({
              sid: 'EcrGetAuthToken',
              effect: iam.Effect.ALLOW,
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            // Restrict image-level actions to only the 5 repos in this stack
            new iam.PolicyStatement({
              sid: 'EcrDescribeImages',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:DescribeImages',
                'ecr:BatchGetImage',
                'ecr:ListImages',
              ],
              resources: allRepoArns,
            }),
            new iam.PolicyStatement({
              sid: 'SsmPutDigests',
              effect: iam.Effect.ALLOW,
              actions: [
                'ssm:PutParameter',
                'ssm:GetParameter',
                'ssm:DeleteParameter',
              ],
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter${paramNamespace}/ecr/digests/*`,
              ],
            }),
            new iam.PolicyStatement({
              sid: 'KmsForEcr',
              effect: iam.Effect.ALLOW,
              actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
              resources: [healthOmicsCmkArn],
            }),
          ],
        }),
      },
    });

    // Inline Lambda: fetch ECR image digests and write to SSM with full error handling
    const digestFetcherCode = `
'use strict';
const { ECRClient, DescribeImagesCommand } = require('@aws-sdk/client-ecr');
const { SSMClient, PutParameterCommand, DeleteParameterCommand } = require('@aws-sdk/client-ssm');
const https = require('https');

const ecrClient = new ECRClient({ region: process.env.AWS_REGION });
const ssmClient = new SSMClient({ region: process.env.AWS_REGION });

const sendCfnResponse = (event, context, status, data, reason) => {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || (status === 'FAILED' ? 'See CloudWatch logs for details' : 'OK'),
    PhysicalResourceId: event.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data || {},
  });

  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(event.ResponseURL);
      const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'PUT',
        headers: { 'Content-Type': '', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(options, (res) => {
        console.log('CFN response status:', res.statusCode);
        resolve();
      });
      req.on('error', (err) => {
        console.error('CFN response error:', err);
        reject(err);
      });
      req.write(body);
      req.end();
    } catch (e) {
      console.error('sendCfnResponse error:', e);
      reject(e);
    }
  });
};

exports.handler = async (event, context) => {
  console.log('Event:', JSON.stringify(event));
  const props = event.ResourceProperties;

  try {
    if (event.RequestType === 'Delete') {
      const names = JSON.parse(props.ImageNames || '[]');
      for (const name of names) {
        try {
          await ssmClient.send(new DeleteParameterCommand({
            Name: props.ParamNamespace + '/ecr/digests/' + name,
          }));
          console.log('Deleted digest param for', name);
        } catch (deleteErr) {
          // Non-fatal: param may not exist yet
          console.log('Delete param error (non-fatal) for', name, ':', deleteErr.message);
        }
      }
      await sendCfnResponse(event, context, 'SUCCESS', {}, 'Digests cleaned up');
      return;
    }

    const images = JSON.parse(props.Images || '[]');
    const results = {};
    const errors = [];

    for (const img of images) {
      try {
        // imageUri format: <account>.dkr.ecr.<region>.amazonaws.com/<repo>:<tag>
        const uriParts = img.imageUri.split('/');
        const repoAndTag = uriParts.slice(1).join('/');
        const colonIdx = repoAndTag.lastIndexOf(':');
        if (colonIdx === -1) {
          throw new Error('Cannot parse imageUri: ' + img.imageUri);
        }
        const repoName = repoAndTag.substring(0, colonIdx);
        const imageTag = repoAndTag.substring(colonIdx + 1);

        const response = await ecrClient.send(new DescribeImagesCommand({
          repositoryName: repoName,
          imageIds: [{ imageTag }],
        }));

        const imageDetail = response.imageDetails && response.imageDetails[0];
        const digest = imageDetail && imageDetail.imageDigest;

        if (!digest) {
          throw new Error('No digest found in DescribeImages response for ' + img.name);
        }

        await ssmClient.send(new PutParameterCommand({
          Name: props.ParamNamespace + '/ecr/digests/' + img.name,
          Value: digest,
          Type: 'String',
          Description: 'SHA256 digest for ' + img.name + ' (run: ' + props.RunId + ')',
          Overwrite: true,
        }));

        results[img.name] = digest;
        console.log('Stored digest for', img.name, ':', digest);

      } catch (imgErr) {
        const msg = imgErr && imgErr.message ? imgErr.message : String(imgErr);
        errors.push(img.name + ': ' + msg);
        console.error('Error processing image', img.name, ':', msg);
      }
    }

    if (errors.length === images.length && images.length > 0) {
      // All images failed — report failure
      await sendCfnResponse(event, context, 'FAILED', results, errors.join('; '));
    } else {
      // Partial or full success
      if (errors.length > 0) {
        console.warn('Some images failed to process:', errors.join('; '));
      }
      await sendCfnResponse(event, context, 'SUCCESS', results);
    }

  } catch (fatalErr) {
    const msg = fatalErr && fatalErr.message ? fatalErr.message : String(fatalErr);
    console.error('Fatal error in digest fetcher:', msg);
    try {
      await sendCfnResponse(event, context, 'FAILED', {}, msg);
    } catch (cfnErr) {
      console.error('Failed to send CFN FAILED response:', cfnErr);
    }
  }
};
`;

    const digestFetcherFn = new lambda.Function(this, 'DigestFetcherFn', {
      functionName: `${resourcePrefix}-amr-digest-fetcher`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(digestFetcherCode),
      role: digestFetcherRole,
      timeout: cdk.Duration.minutes(5),
      description: `${resourcePrefix} AMR: fetch ECR image digests and store in SSM`,
    });

    const digestFetcherProvider = new cr.Provider(this, 'DigestFetcherProvider', {
      onEventHandler: digestFetcherFn,
    });

    const imageList = [
      { name: 'sra-tools', imageUri: sraToolsImage.imageUri },
      { name: 'fastp-skesa', imageUri: fastpSkesaImage.imageUri },
      { name: 'funcscan', imageUri: funcscanImage.imageUri },
      { name: 'hamronization', imageUri: hamronizationImage.imageUri },
      { name: 'agent-runtime', imageUri: agentRuntimeImage.imageUri },
    ];

    new cdk.CustomResource(this, 'DigestFetcherResource', {
      serviceToken: digestFetcherProvider.serviceToken,
      properties: {
        ParamNamespace: paramNamespace,
        RunId: runId,
        Images: cdk.Lazy.string({
          produce: () => JSON.stringify(imageList.map(i => ({ name: i.name, imageUri: i.imageUri }))),
        }),
        ImageNames: JSON.stringify(imageList.map(i => i.name)),
        ForceUpdate: runId,
      },
    });

    // ─── ECR repo ARNs in SSM for cross-stack access ──────────────────────────
    const repoParams: Array<{ name: string; repo: ecr.Repository }> = [
      { name: 'sra-tools', repo: sraToolsRepo },
      { name: 'fastp-skesa', repo: fastpSkesaRepo },
      { name: 'funcscan', repo: funcscanRepo },
      { name: 'hamronization', repo: hamronizationRepo },
      { name: 'agent-runtime', repo: agentRuntimeRepo },
    ];

    for (const { name, repo } of repoParams) {
      new ssm.StringParameter(this, `param-repo-arn-${name}`, {
        parameterName: `${paramNamespace}/ecr/repo-arn/${name}`,
        stringValue: repo.repositoryArn,
        description: `${resourcePrefix} AMR ECR repository ARN for ${name}`,
        tier: ssm.ParameterTier.STANDARD,
      });
    }

    // ─── CloudFormation outputs ───────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SraToolsRepoUri', {
      value: sraToolsRepo.repositoryUri,
      exportName: `${resourcePrefix}-amr-sra-tools-repo-uri`,
    });
    new cdk.CfnOutput(this, 'FastpSkesaRepoUri', {
      value: fastpSkesaRepo.repositoryUri,
      exportName: `${resourcePrefix}-amr-fastp-skesa-repo-uri`,
    });
    new cdk.CfnOutput(this, 'FuncscanRepoUri', {
      value: funcscanRepo.repositoryUri,
      exportName: `${resourcePrefix}-amr-funcscan-repo-uri`,
    });
    new cdk.CfnOutput(this, 'HamronizationRepoUri', {
      value: hamronizationRepo.repositoryUri,
      exportName: `${resourcePrefix}-amr-hamronization-repo-uri`,
    });
    new cdk.CfnOutput(this, 'AgentRuntimeRepoUri', {
      value: agentRuntimeRepo.repositoryUri,
      exportName: `${resourcePrefix}-amr-agent-runtime-repo-uri`,
    });
    new cdk.CfnOutput(this, 'SraToolsImageUri', {
      value: sraToolsImage.imageUri,
      exportName: `${resourcePrefix}-amr-sra-tools-image-uri`,
    });
    new cdk.CfnOutput(this, 'FastpSkesaImageUri', {
      value: fastpSkesaImage.imageUri,
      exportName: `${resourcePrefix}-amr-fastp-skesa-image-uri`,
    });
    new cdk.CfnOutput(this, 'FuncscanImageUri', {
      value: funcscanImage.imageUri,
      exportName: `${resourcePrefix}-amr-funcscan-image-uri`,
    });
    new cdk.CfnOutput(this, 'HamronizationImageUri', {
      value: hamronizationImage.imageUri,
      exportName: `${resourcePrefix}-amr-hamronization-image-uri`,
    });
    new cdk.CfnOutput(this, 'AgentRuntimeImageUri', {
      value: agentRuntimeImage.imageUri,
      exportName: `${resourcePrefix}-amr-agent-runtime-image-uri`,
    });
    new cdk.CfnOutput(this, 'EcrDigestsParamPath', {
      value: `${paramNamespace}/ecr/digests`,
      exportName: `${resourcePrefix}-amr-ecr-digests-param-path`,
    });

    // Expose for programmatic access by other stacks
    this.repoArns = {
      sraTools: sraToolsRepo.repositoryArn,
      fastpSkesa: fastpSkesaRepo.repositoryArn,
      funcscan: funcscanRepo.repositoryArn,
      hamronization: hamronizationRepo.repositoryArn,
      agentRuntime: agentRuntimeRepo.repositoryArn,
    };
    this.imageUris = {
      // sra-tools runs on ECS Fargate, which pulls fine from the CDK assets repo.
      sraTools: sraToolsImage.imageUri,
      // fastp-skesa and funcscan run inside HealthOmics, which can only pull from
      // the dedicated repos that carry the omics resource policy — expose those.
      fastpSkesa: fastpSkesaTargetUri,
      funcscan: funcscanTargetUri,
      hamronization: hamronizationImage.imageUri,
      agentRuntime: agentRuntimeImage.imageUri,
    };
  }
}
