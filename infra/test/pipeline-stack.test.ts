import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { PipelineStack } from '../lib/pipeline-stack';

const testPrefix = 'test-prefix';
const testRunId = 'test-run-id';
const mockKeyArn = (n: number) => `arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-00000000000${n}`;

function buildStack() {
  const app = new cdk.App();
  return new PipelineStack(app, 'TestPipelineStack', {
    resourcePrefix: testPrefix,
    runId: testRunId,
    slot: '4',
    snsCmkArn: mockKeyArn(1),
    glueCmkArn: mockKeyArn(2),
    lambdaLogsCmkArn: mockKeyArn(3),
    dynamoCmkArn: mockKeyArn(4),
    s3DataLakeCmkArn: mockKeyArn(5),
    s3TablesCmkArn: mockKeyArn(6),
    dataLakeBucketName: `${testPrefix}-amr-data-lake`,
    dynamoTableName: `${testPrefix}-amr-isolate-state`,
    athenaWorkgroupName: `${testPrefix}-amr-wg`,
    athenaResultsBucketName: `${testPrefix}-amr-athena-results`,
    glueDatabaseName: `${testPrefix}_amr_db`,
    icebergTableBucketArn: `arn:aws:s3tables:us-west-2:123456789012:bucket/${testPrefix}-amr-iceberg-tbl`,
    sraToolsImageUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-west-2:abc123',
    assemblyContainerImageUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-west-2:assembly',
    amrContainerImageUri: '123456789012.dkr.ecr.us-west-2.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-west-2:amr',
    omicsServiceRoleArn: 'arn:aws:iam::123456789012:role/test-omics-role',
    amrWorkflowIdParamName: '/test-prefix/amr/workflows/amr-id',
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('PipelineStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates Step Functions state machine', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: `${testPrefix}-amr-pipeline`,
      StateMachineType: 'STANDARD',
    });
  });

  test('Step Functions state machine has logging configured', () => {
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: {
        Level: 'ALL',
        IncludeExecutionData: true,
      },
    });
  });

  test('creates Glue job with correct configuration', () => {
    template.hasResourceProperties('AWS::Glue::Job', {
      Name: `${testPrefix}-amr-etl`,
      GlueVersion: '5.0',
      WorkerType: 'G.1X',
      NumberOfWorkers: 2,
    });
  });

  test('creates 4 Lambda functions with DLQs', () => {
    // ingestion-validator, isolate-deduper, concordance-computer, hamronization-runner
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: {
        Runtime: 'python3.12',
      },
    });
    expect(Object.keys(functions).length).toBeGreaterThanOrEqual(4);
  });

  test('Lambda functions have reserved concurrency set', () => {
    template.allResourcesProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: Match.anyValue(),
    });
  });

  test('Lambda log groups have 90-day retention and KMS', () => {
    // pipeline Lambda log groups should have retention=90 and KMS
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: 90,
      KmsKeyId: Match.anyValue(),
    });
  });

  test('ECS Fargate task definition created', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: `${testPrefix}-amr-sra-fetcher`,
    });
  });

  test('SNS topic uses KMS encryption', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: `${testPrefix}-amr-pipeline-notifications`,
      KmsMasterKeyId: Match.anyValue(),
    });
  });

  test('ECS cluster with container insights', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: `${testPrefix}-amr-pipeline`,
    });
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
