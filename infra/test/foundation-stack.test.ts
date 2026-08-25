import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoundationStack } from '../lib/foundation-stack';

const testPrefix = 'test-prefix';
const testRunId = 'test-run-id';

function buildStack() {
  const app = new cdk.App();
  return new FoundationStack(app, 'TestFoundationStack', {
    resourcePrefix: testPrefix,
    runId: testRunId,
    slot: '0',
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('FoundationStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates 7 KMS keys with rotation enabled', () => {
    template.resourceCountIs('AWS::KMS::Key', 7);
    template.allResourcesProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  test('each KMS key has correct deletion policy (retain)', () => {
    const keys = template.findResources('AWS::KMS::Key');
    for (const [, resource] of Object.entries(keys)) {
      expect(resource.DeletionPolicy).toBe('Retain');
    }
  });

  test('KMS keys have service principal grants in policy', () => {
    // Lambda logs key should allow logs service
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Principal: Match.objectLike({
              Service: Match.stringLikeRegexp('logs'),
            }),
          }),
        ]),
      }),
    });
  });

  test('creates 7 KMS aliases', () => {
    template.resourceCountIs('AWS::KMS::Alias', 7);
  });

  test('creates SSM parameters for CMK ARNs', () => {
    // At least 8 SSM params (7 CMK ARNs + 1 namespace placeholder)
    const params = template.findResources('AWS::SSM::Parameter');
    expect(Object.keys(params).length).toBeGreaterThanOrEqual(8);
  });

  test('exports CMK ARNs as CloudFormation outputs', () => {
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    expect(outputKeys).toContain('S3DataLakeCmkArn');
    expect(outputKeys).toContain('LambdaLogsCmkArn');
    expect(outputKeys).toContain('DynamoCmkArn');
    expect(outputKeys).toContain('GlueCmkArn');
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
