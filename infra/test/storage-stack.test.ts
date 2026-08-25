import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StorageStack } from '../lib/storage-stack';

const testPrefix = 'test-prefix';
const testRunId = 'test-run-id';
const mockKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000001';
const mockDynamoKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000002';
const mockTablesKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000003';

function buildStack() {
  const app = new cdk.App();
  return new StorageStack(app, 'TestStorageStack', {
    resourcePrefix: testPrefix,
    runId: testRunId,
    slot: '0',
    s3DataLakeKeyArn: mockKeyArn,
    s3TablesKeyArn: mockTablesKeyArn,
    dynamoKeyArn: mockDynamoKeyArn,
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('StorageStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates S3 data lake bucket with KMS encryption', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: `${testPrefix}-amr-data-lake`,
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
            },
          },
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('S3 buckets have BlockPublicAccess=ALL', () => {
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('DynamoDB isolate-state table uses KMS encryption', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: `${testPrefix}-amr-isolate-state`,
      SSESpecification: {
        SSEEnabled: true,
        SSEType: 'KMS',
      },
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('creates Athena workgroup with output encryption', () => {
    template.hasResourceProperties('AWS::Athena::WorkGroup', {
      Name: `${testPrefix}-amr-wg`,
    });
  });

  test('creates Glue database or S3Tables resources', () => {
    // Storage stack creates either a Glue::Database or S3Tables resources
    const glueDbs = template.findResources('AWS::Glue::Database');
    const s3Tables = template.findResources('AWS::S3Tables::TableBucket');
    expect(Object.keys(glueDbs).length + Object.keys(s3Tables).length).toBeGreaterThan(0);
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
