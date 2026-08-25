import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ApiStack } from '../lib/api-stack';

const testPrefix = 'test-prefix';
const mockLambdaLogsKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000001';

function buildStack() {
  const app = new cdk.App({
    context: {
      // Provide SSM context values for test
      [`ssm:account=123456789012:parameterName=/${testPrefix}/amr/foundation/dynamo-cmk-arn:region=us-west-2`]: mockLambdaLogsKeyArn,
      [`ssm:account=123456789012:parameterName=/${testPrefix}/amr/foundation/s3-data-lake-cmk-arn:region=us-west-2`]: mockLambdaLogsKeyArn,
      // SSM params for AgentCore image
      [`ssm:account=123456789012:parameterName=/${testPrefix}/amr/ecr/image-uri/agent-runtime:region=us-west-2`]: '123456789012.dkr.ecr.us-west-2.amazonaws.com/test:latest',
      [`ssm:account=123456789012:parameterName=/${testPrefix}/amr/ecr/repo-arn/agent-runtime:region=us-west-2`]: 'arn:aws:ecr:us-west-2:123456789012:repository/test',
    },
  });
  return new ApiStack(app, 'TestApiStack', {
    resourcePrefix: testPrefix,
    runId: 'test-run-id',
    slot: '0',
    lambdaLogsCmkArn: mockLambdaLogsKeyArn,
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('ApiStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates Cognito User Pool with self-signup disabled', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: `${testPrefix}-amr-users`,
      AdminCreateUserConfig: {
        AllowAdminCreateUserOnly: true,
      },
      MfaConfiguration: 'OFF',
    });
  });

  test('creates Cognito hosted UI domain', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: `${testPrefix}-amr-auth`,
    });
  });

  test('creates API Gateway with Cognito authorizer', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.resourceCountIs('AWS::ApiGateway::Authorizer', 1);
  });

  test('API Gateway has usage plan with quota >= 50000', () => {
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      Quota: {
        Limit: 50000,
        Period: 'DAY',
      },
    });
  });

  test('Lambda log groups have KMS encryption and 90-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
      KmsKeyId: Match.anyValue(),
    });
  });

  test('creates WebSocket API', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: `${testPrefix}-amr-ws`,
      ProtocolType: 'WEBSOCKET',
    });
  });

  test('creates Bedrock guardrail', () => {
    template.hasResourceProperties('AWS::Bedrock::Guardrail', {
      Name: `${testPrefix}-amr-guardrail`,
    });
  });

  test('creates AgentCore runtime', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
  });

  test('/health endpoint exists without auth (intentionally public)', () => {
    // Mock integration for /health
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      AuthorizationType: 'NONE',
    });
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
