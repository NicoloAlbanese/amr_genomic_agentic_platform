import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ContainersStack } from '../lib/containers-stack';

const testPrefix = 'test-prefix';
const mockHealthOmicsKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000001';

function buildStack() {
  const app = new cdk.App();
  return new ContainersStack(app, 'TestContainersStack', {
    resourcePrefix: testPrefix,
    runId: 'test-run-id',
    slot: '0',
    healthOmicsCmkArn: mockHealthOmicsKeyArn,
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('ContainersStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates ECR repositories with scan on push', () => {
    template.allResourcesProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: {
        ScanOnPush: true,
      },
    });
  });

  test('ECR repositories have immutable tags', () => {
    template.allResourcesProperties('AWS::ECR::Repository', {
      ImageTagMutability: 'IMMUTABLE',
    });
  });

  test('ECR repos use KMS encryption', () => {
    template.allResourcesProperties('AWS::ECR::Repository', {
      EncryptionConfiguration: Match.objectLike({
        EncryptionType: 'KMS',
      }),
    });
  });

  test('creates agent-runtime ECR repository', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: `${testPrefix}-amr-agent-runtime`,
    });
  });

  test('creates sra-tools ECR repository', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: `${testPrefix}-amr-sra-tools`,
    });
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
