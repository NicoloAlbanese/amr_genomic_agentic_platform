import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface FoundationStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
}

export class FoundationStack extends cdk.Stack {
  public readonly s3DataLakeKey: kms.Key;
  public readonly s3TablesKey: kms.Key;
  public readonly dynamoKey: kms.Key;
  public readonly glueKey: kms.Key;
  public readonly healthOmicsKey: kms.Key;
  public readonly lambdaLogsKey: kms.Key;
  public readonly snsKey: kms.Key;
  public readonly paramNamespace: string;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);

    const { resourcePrefix } = props;
    this.paramNamespace = `/${resourcePrefix}/amr`;

    // Helper: create a KMS CMK with rotation + alias + service-principal key policy
    const createServiceKey = (
      name: string,
      description: string,
      servicePrincipals: string[],
    ): kms.Key => {
      const key = new kms.Key(this, `${name}-key`, {
        description,
        enableKeyRotation: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        policy: new iam.PolicyDocument({
          statements: [
            // Root account admin access (required to prevent lockout — KMS Pattern 10)
            new iam.PolicyStatement({
              sid: 'EnableRootAccountAdmin',
              effect: iam.Effect.ALLOW,
              principals: [
                new iam.AccountRootPrincipal(),
              ],
              actions: ['kms:*'],
              resources: ['*'],
            }),
            // Allow the deploying account to use the key via service calls
            ...servicePrincipals.map(
              (svcPrincipal) =>
                new iam.PolicyStatement({
                  sid: `Allow${svcPrincipal.replace(/[^a-zA-Z0-9]/g, '')}Access`,
                  effect: iam.Effect.ALLOW,
                  principals: [new iam.ServicePrincipal(svcPrincipal)],
                  actions: [
                    'kms:GenerateDataKey*',
                    'kms:Decrypt',
                    'kms:Encrypt',
                    'kms:ReEncrypt*',
                    'kms:DescribeKey',
                    'kms:CreateGrant',
                  ],
                  resources: ['*'],
                }),
            ),
          ],
        }),
      });

      new kms.Alias(this, `${name}-alias`, {
        aliasName: `alias/${resourcePrefix}-${name}`,
        targetKey: key,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      return key;
    };

    // 1. S3 Data Lake CMK
    this.s3DataLakeKey = createServiceKey(
      's3-data-lake-cmk',
      `${resourcePrefix} S3 Data Lake encryption key`,
      ['s3.amazonaws.com'],
    );

    // 2. S3 Tables CMK
    // Per runbook Pattern 3: maintenance.s3tables.amazonaws.com MUST be in the
    // key policy (not just a grant) for kms:Decrypt + kms:GenerateDataKey,
    // otherwise managed compaction cannot access encrypted tables and the
    // entire s3tablescatalog disappears from Athena.
    // lakeformation.amazonaws.com is also required for Athena query access.
    this.s3TablesKey = createServiceKey(
      's3-tables-cmk',
      `${resourcePrefix} S3 Tables encryption key`,
      [
        's3.amazonaws.com',
        'maintenance.s3tables.amazonaws.com',
        'lakeformation.amazonaws.com',
      ],
    );

    // 3. DynamoDB CMK
    this.dynamoKey = createServiceKey(
      'dynamo-cmk',
      `${resourcePrefix} DynamoDB encryption key`,
      ['dynamodb.amazonaws.com'],
    );

    // 4. Glue CMK
    this.glueKey = createServiceKey(
      'glue-cmk',
      `${resourcePrefix} Glue encryption key`,
      ['glue.amazonaws.com'],
    );

    // 5. HealthOmics CMK
    this.healthOmicsKey = createServiceKey(
      'healthomics-cmk',
      `${resourcePrefix} HealthOmics encryption key`,
      ['omics.amazonaws.com'],
    );

    // 6. Lambda Logs CMK
    this.lambdaLogsKey = createServiceKey(
      'lambda-logs-cmk',
      `${resourcePrefix} Lambda logs encryption key`,
      [
        `logs.${this.region}.amazonaws.com`,
        'lambda.amazonaws.com',
      ],
    );

    // 7. SNS CMK
    this.snsKey = createServiceKey(
      'sns-cmk',
      `${resourcePrefix} SNS encryption key`,
      ['sns.amazonaws.com'],
    );

    // SSM Parameter namespace — placeholder param to establish namespace
    new ssm.StringParameter(this, 'amr-namespace-param', {
      parameterName: `${this.paramNamespace}/foundation/stack-name`,
      stringValue: this.stackName,
      description: `${resourcePrefix} AMR foundation stack name`,
      tier: ssm.ParameterTier.STANDARD,
    });

    // Export CMK ARNs as SSM parameters for cross-stack reference
    const keyExports: Array<{ paramSuffix: string; key: kms.Key }> = [
      { paramSuffix: 's3-data-lake-cmk-arn', key: this.s3DataLakeKey },
      { paramSuffix: 's3-tables-cmk-arn', key: this.s3TablesKey },
      { paramSuffix: 'dynamo-cmk-arn', key: this.dynamoKey },
      { paramSuffix: 'glue-cmk-arn', key: this.glueKey },
      { paramSuffix: 'healthomics-cmk-arn', key: this.healthOmicsKey },
      { paramSuffix: 'lambda-logs-cmk-arn', key: this.lambdaLogsKey },
      { paramSuffix: 'sns-cmk-arn', key: this.snsKey },
    ];

    for (const { paramSuffix, key } of keyExports) {
      new ssm.StringParameter(this, `param-${paramSuffix}`, {
        parameterName: `${this.paramNamespace}/foundation/${paramSuffix}`,
        stringValue: key.keyArn,
        description: `${resourcePrefix} AMR ${paramSuffix}`,
        tier: ssm.ParameterTier.STANDARD,
      });
    }

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'S3DataLakeCmkArn', {
      value: this.s3DataLakeKey.keyArn,
      exportName: `${resourcePrefix}-s3-data-lake-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'S3TablesCmkArn', {
      value: this.s3TablesKey.keyArn,
      exportName: `${resourcePrefix}-s3-tables-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'DynamoCmkArn', {
      value: this.dynamoKey.keyArn,
      exportName: `${resourcePrefix}-dynamo-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'GlueCmkArn', {
      value: this.glueKey.keyArn,
      exportName: `${resourcePrefix}-glue-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'HealthOmicsCmkArn', {
      value: this.healthOmicsKey.keyArn,
      exportName: `${resourcePrefix}-healthomics-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'LambdaLogsCmkArn', {
      value: this.lambdaLogsKey.keyArn,
      exportName: `${resourcePrefix}-lambda-logs-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'SnsCmkArn', {
      value: this.snsKey.keyArn,
      exportName: `${resourcePrefix}-sns-cmk-arn`,
    });
    new cdk.CfnOutput(this, 'SsmParamNamespace', {
      value: this.paramNamespace,
      exportName: `${resourcePrefix}-ssm-param-namespace`,
    });
  }
}
