import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface WafStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
}

/**
 * WAF WebACL for CloudFront.
 *
 * MUST be deployed in us-east-1 — WAF with CLOUDFRONT scope is a global resource
 * that must reside in us-east-1 regardless of where the CloudFront distribution lives.
 */
export class WafStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: WafStackProps) {
    // Force us-east-1 — CloudFront WAF requirement
    super(scope, id, {
      ...props,
      env: { account: props.env?.account, region: 'us-east-1' },
    });

    const prefix = props.resourcePrefix;

    // ---------------------------------------------------------
    // WAF WebACL — CLOUDFRONT scope
    // AWS Managed rules provide common protection without custom rules
    // ---------------------------------------------------------
    const webAcl = new wafv2.CfnWebACL(this, 'FrontendWebAcl', {
      name: `${prefix}-amr-frontend-waf`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${prefix}-amr-frontend-waf`,
      },
      rules: [
        // AWS Managed: Core Rule Set (SQLi, XSS, etc.)
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 10,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-amr-waf-common`,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        },
        // AWS Managed: Known Bad Inputs
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 20,
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-amr-waf-badinputs`,
          },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        },
        // Rate limit — 1000 req/5-min per IP to protect API
        {
          name: 'RateLimitPerIp',
          priority: 30,
          action: { block: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: `${prefix}-amr-waf-ratelimit`,
          },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: 'IP',
            },
          },
        },
      ],
    });

    this.webAclArn = webAcl.attrArn;

    // Export ARN to SSM so FrontendStack (us-west-2) can reference it at deploy time
    new ssm.StringParameter(this, 'WebAclArnParam', {
      parameterName: `/${prefix}/amr/waf/frontend-web-acl-arn`,
      stringValue: webAcl.attrArn,
      description: `${prefix} AMR Frontend WAF WebACL ARN`,
    });

    // CloudFormation output
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: webAcl.attrArn,
      description: 'Frontend WAF WebACL ARN',
      exportName: `${prefix}-amr-frontend-waf-arn`,
    });
  }
}
