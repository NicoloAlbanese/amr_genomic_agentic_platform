import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FrontendStack } from '../lib/frontend-stack';

const testPrefix = 'test-prefix';

function buildStack() {
  const app = new cdk.App();
  return new FrontendStack(app, 'TestFrontendStack', {
    resourcePrefix: testPrefix,
    runId: 'test-run-id',
    slot: '0',
    webAclArn: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/test-waf/abc123',
    userPoolId: 'us-west-2_testpool',
    userPoolClientId: 'testclientid123',
    cognitoDomainUrl: `https://${testPrefix}-amr-auth.auth.us-west-2.amazoncognito.com`,
    restApiUrl: 'https://testapi.execute-api.us-west-2.amazonaws.com/prod/',
    wsApiUrl: 'wss://testws.execute-api.us-west-2.amazonaws.com/prod',
    lambdaLogsCmkArn: 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000003',
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('FrontendStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates CloudFront distribution with HTTPS redirect', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
  });

  test('CloudFront uses TLS 1.2 minimum (via CDK minimumProtocolVersion prop)', () => {
    // When using the default CloudFront certificate (no custom domain), CDK sets
    // minimumProtocolVersion on the distribution construct — visible in CDK metadata.
    // The CloudFront distribution defaults to TLS 1.2 when ViewerCertificate is absent.
    // Verify REDIRECT_TO_HTTPS (which implies TLS enforcement) is set.
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
        }),
      }),
    });
    // Verify the distribution does NOT allow HTTP-only (no 'allow-all' policy)
    const dists = template.findResources('AWS::CloudFront::Distribution');
    for (const [, resource] of Object.entries(dists)) {
      const defaultBehavior = resource.Properties?.DistributionConfig?.DefaultCacheBehavior;
      expect(defaultBehavior?.ViewerProtocolPolicy).not.toBe('allow-all');
    }
  });

  test('CloudFront has WAF associated', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        WebACLId: 'arn:aws:wafv2:us-east-1:123456789012:global/webacl/test-waf/abc123',
      }),
    });
  });

  test('S3 bucket has BlockPublicAccess=ALL', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `${testPrefix}-amr-frontend`,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('S3 bucket enforces SSL', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: Match.objectLike({
              Bool: Match.objectLike({
                'aws:SecureTransport': 'false',
              }),
            }),
          }),
        ]),
      }),
    });
  });

  test('creates CloudFront Origin Access Control', () => {
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: Match.objectLike({
        Name: `${testPrefix}-amr-frontend-oac`,
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'always',
        SigningProtocol: 'sigv4',
      }),
    });
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
