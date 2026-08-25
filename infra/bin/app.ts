#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack';
import { StorageStack } from '../lib/storage-stack';
import { ContainersStack } from '../lib/containers-stack';
import { GenomicsStack } from '../lib/genomics-stack';
import { PipelineStack } from '../lib/pipeline-stack';
import { ApiStack } from '../lib/api-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { WafStack } from '../lib/waf-stack';

// Read required environment variables
const resourcePrefix = process.env.RESOURCE_PREFIX;
const runId = process.env.RUN_ID;
const slot = process.env.SLOT ?? '0';
const region = process.env.AWS_DEFAULT_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-west-2';
const account = process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID;

if (!resourcePrefix) {
  throw new Error('RESOURCE_PREFIX environment variable is required');
}
if (!runId) {
  throw new Error('RUN_ID environment variable is required');
}

const app = new cdk.App();

// Apply global tags to all resources
cdk.Tags.of(app).add('apex:run-id', runId);
cdk.Tags.of(app).add('apex:prefix', resourcePrefix);
cdk.Tags.of(app).add('apex:cost-center', 'amr-pipeline');

// Common stack props
const env: cdk.Environment = { account, region };

const commonProps = {
  resourcePrefix,
  runId,
  slot,
  env,
};

// The stacks are wired together using real CDK cross-stack references (stack
// object properties), not hardcoded ARNs. This keeps the app account-agnostic:
// a plain `cdk deploy --all` into any bootstrapped account resolves every
// KMS key, bucket, workflow, and image reference from the actual deployed
// resources. CloudFormation orders the deploys from the addDependency edges.

// 1. Foundation Stack — KMS CMKs, SSM namespace
const foundationStack = new FoundationStack(
  app,
  `${resourcePrefix}-amr-foundation`,
  {
    ...commonProps,
    description: `${resourcePrefix} AMR Foundation: KMS CMKs and SSM namespace`,
  },
);

// 2. Storage Stack — S3 Data Lake, S3 Tables, DynamoDB
const storageStack = new StorageStack(
  app,
  `${resourcePrefix}-amr-storage`,
  {
    ...commonProps,
    description: `${resourcePrefix} AMR Storage: S3 Data Lake, S3 Tables, DynamoDB`,
    s3DataLakeKeyArn: foundationStack.s3DataLakeKey.keyArn,
    s3TablesKeyArn: foundationStack.s3TablesKey.keyArn,
    dynamoKeyArn: foundationStack.dynamoKey.keyArn,
  },
);
storageStack.addDependency(foundationStack);

// 3. Containers Stack — ECR repos + bioinformatics Docker images
const containersStack = new ContainersStack(
  app,
  `${resourcePrefix}-amr-containers`,
  {
    ...commonProps,
    description: `${resourcePrefix} AMR Containers: ECR bioinformatics images`,
    healthOmicsCmkArn: foundationStack.healthOmicsKey.keyArn,
  },
);
containersStack.addDependency(foundationStack);

// 4. Genomics Stack — HealthOmics workflows, reference stores
const genomicsStack = new GenomicsStack(
  app,
  `${resourcePrefix}-amr-genomics`,
  {
    ...commonProps,
    description: `${resourcePrefix} AMR Genomics: HealthOmics workflows`,
    healthOmicsCmkArn: foundationStack.healthOmicsKey.keyArn,
    s3DataLakeCmkArn: foundationStack.s3DataLakeKey.keyArn,
  },
);
genomicsStack.addDependency(storageStack);

// 5. Pipeline Stack — Step Functions, Glue, data pipelines
const pipelineStack = new PipelineStack(
  app,
  `${resourcePrefix}-amr-pipeline`,
  {
    ...commonProps,
    description: `${resourcePrefix} AMR Pipeline: Step Functions and Glue`,
    snsCmkArn: foundationStack.snsKey.keyArn,
    glueCmkArn: foundationStack.glueKey.keyArn,
    lambdaLogsCmkArn: foundationStack.lambdaLogsKey.keyArn,
    dynamoCmkArn: foundationStack.dynamoKey.keyArn,
    s3DataLakeCmkArn: foundationStack.s3DataLakeKey.keyArn,
    s3TablesCmkArn: foundationStack.s3TablesKey.keyArn,
    dataLakeBucketName: storageStack.dataLakeBucket.bucketName,
    dynamoTableName: storageStack.isolateStateTable.tableName,
    athenaWorkgroupName: storageStack.athenaWorkgroupName,
    athenaResultsBucketName: storageStack.athenaResultsBucket.bucketName,
    glueDatabaseName: storageStack.glueDatabaseName,
    icebergTableBucketArn: storageStack.icebergTableBucketArn,
    sraToolsImageUri: containersStack.imageUris.sraTools,
    assemblyContainerImageUri: containersStack.imageUris.fastpSkesa,
    amrContainerImageUri: containersStack.imageUris.funcscan,
    omicsServiceRoleArn: genomicsStack.omicsServiceRoleArn,
    amrWorkflowIdParamName: genomicsStack.amrWorkflowIdParamName,
  },
);
pipelineStack.addDependency(storageStack);
pipelineStack.addDependency(genomicsStack);
pipelineStack.addDependency(containersStack);

// 6. API Stack — API Gateway, Lambda, Cognito
const apiStack = new ApiStack(
  app,
  `${resourcePrefix}-amr-api`,
  {
    ...commonProps,
    description: `${resourcePrefix} AMR API: API Gateway, Lambda, Cognito`,
    lambdaLogsCmkArn: foundationStack.lambdaLogsKey.keyArn,
  },
);
apiStack.addDependency(storageStack);
apiStack.addDependency(pipelineStack);

// 7a. WAF Stack — MUST be in us-east-1 for CloudFront scope
// WAF for CloudFront distributions requires CLOUDFRONT scope which is a global
// resource and must be created in us-east-1 regardless of the app region.
const wafStack = new WafStack(
  app,
  `${resourcePrefix}-amr-waf`,
  {
    ...commonProps,
    // Override region to us-east-1 for WAF
    env: { account, region: 'us-east-1' },
    crossRegionReferences: true,
    description: `${resourcePrefix} AMR WAF: CloudFront WebACL (us-east-1)`,
  },
);

// 7b. Frontend Stack — CloudFront, S3, React SPA
// The WAF WebACL ARN is a genuine cross-region reference (WAF in us-east-1,
// CloudFront/Frontend in the app region). crossRegionReferences lets CDK wire
// it automatically via an SSM-backed export instead of an env var.
const frontendStack = new FrontendStack(
  app,
  `${resourcePrefix}-amr-frontend`,
  {
    ...commonProps,
    crossRegionReferences: true,
    description: `${resourcePrefix} AMR Frontend: CloudFront and React SPA`,
    webAclArn: wafStack.webAclArn,
    // Cognito + API values used to generate the SPA runtime config and to
    // register the CloudFront callback URL with the Cognito user pool client.
    userPoolId: apiStack.userPoolId,
    userPoolClientId: apiStack.userPoolClientId,
    cognitoDomainUrl: apiStack.cognitoDomainUrl,
    restApiUrl: apiStack.restApiUrl,
    wsApiUrl: apiStack.wsApiUrl,
    lambdaLogsCmkArn: foundationStack.lambdaLogsKey.keyArn,
  },
);
frontendStack.addDependency(apiStack);
frontendStack.addDependency(wafStack);

app.synth();
