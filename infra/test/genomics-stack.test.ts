import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GenomicsStack } from '../lib/genomics-stack';

const testPrefix = 'test-prefix';
const mockKeyArn = 'arn:aws:kms:us-west-2:123456789012:key/00000000-0000-0000-0000-000000000001';

function buildStack() {
  const app = new cdk.App();
  return new GenomicsStack(app, 'TestGenomicsStack', {
    resourcePrefix: testPrefix,
    runId: 'test-run-id',
    slot: '0',
    healthOmicsCmkArn: mockKeyArn,
    s3DataLakeCmkArn: mockKeyArn,
    env: { account: '123456789012', region: 'us-west-2' },
  });
}

describe('GenomicsStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates HealthOmics service role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: Match.objectLike({
              Service: 'omics.amazonaws.com',
            }),
          }),
        ]),
      }),
    });
  });

  test('creates the merged AMR HealthOmics workflow', () => {
    // One workflow (fastp -> SKESA -> AMRFinderPlus). Container image URIs are
    // supplied as run parameters, so the parameter template exposes them.
    const workflows = template.findResources('AWS::Omics::Workflow');
    expect(Object.keys(workflows).length).toBe(1);
    template.hasResourceProperties('AWS::Omics::Workflow', {
      // Name embeds a short definition hash to force replacement on change.
      Name: Match.stringLikeRegexp(`${testPrefix}-amr-genomics-[0-9a-f]+`),
      Engine: 'NEXTFLOW',
      ParameterTemplate: Match.objectLike({
        assembly_container: Match.anyValue(),
        amr_container: Match.anyValue(),
      }),
    });
  });

  test('exports workflow ARN as CFN output', () => {
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);
    expect(outputKeys.some(k => k.toLowerCase().includes('amrworkflow'))).toBe(true);
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
