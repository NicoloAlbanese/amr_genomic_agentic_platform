import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WafStack } from '../lib/waf-stack';

const testPrefix = 'test-prefix';

function buildStack() {
  const app = new cdk.App();
  return new WafStack(app, 'TestWafStack', {
    resourcePrefix: testPrefix,
    runId: 'test-run-id',
    slot: '0',
    // WAF must be in us-east-1
    env: { account: '123456789012', region: 'us-east-1' },
  });
}

describe('WafStack', () => {
  let template: Template;

  beforeAll(() => {
    const stack = buildStack();
    template = Template.fromStack(stack);
  });

  test('creates WAF WebACL with CLOUDFRONT scope', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Name: `${testPrefix}-amr-frontend-waf`,
      Scope: 'CLOUDFRONT',
      DefaultAction: { Allow: {} },
    });
  });

  test('WAF includes AWS managed Common Rule Set', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
          Statement: Match.objectLike({
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesCommonRuleSet',
            },
          }),
        }),
      ]),
    });
  });

  test('WAF includes rate limiting rule', () => {
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'RateLimitPerIp',
          Action: { Block: {} },
        }),
      ]),
    });
  });

  test('exports WebACL ARN to SSM', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: `/${testPrefix}/amr/waf/frontend-web-acl-arn`,
    });
  });

  test('matches snapshot', () => {
    expect(template.toJSON()).toMatchSnapshot();
  });
});
