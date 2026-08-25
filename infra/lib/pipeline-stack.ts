import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface PipelineStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
  snsCmkArn: string;
  glueCmkArn: string;
  lambdaLogsCmkArn: string;
  dynamoCmkArn: string;
  s3DataLakeCmkArn: string;
  s3TablesCmkArn: string;
  dataLakeBucketName: string;
  dynamoTableName: string;
  athenaWorkgroupName: string;
  athenaResultsBucketName: string;
  glueDatabaseName: string;
  icebergTableBucketArn: string;
  sraToolsImageUri: string;
  assemblyContainerImageUri: string;
  amrContainerImageUri: string;
  omicsServiceRoleArn: string;
  /**
   * SSM parameter name that holds the numeric HealthOmics workflow id. The
   * pipeline reads the id from SSM at deploy time rather than importing it as a
   * cross-stack export, so changing the workflow definition never deadlocks on
   * an export that is still in use.
   */
  amrWorkflowIdParamName: string;
}

export class PipelineStack extends cdk.Stack {
  public readonly stateMachineArn: string;
  public readonly snsTopicArn: string;

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const { resourcePrefix, runId, slot,
      snsCmkArn, glueCmkArn, lambdaLogsCmkArn, dynamoCmkArn, s3DataLakeCmkArn, s3TablesCmkArn,
      dataLakeBucketName, dynamoTableName, athenaWorkgroupName,
      athenaResultsBucketName, glueDatabaseName, icebergTableBucketArn,
      sraToolsImageUri, assemblyContainerImageUri, amrContainerImageUri,
      omicsServiceRoleArn, amrWorkflowIdParamName } = props;

    const account = this.account;
    const region  = this.region;

    // The HealthOmics workflow id is read from SSM at pipeline EXECUTION time
    // (a getParameter task in the state machine), not imported from GenomicsStack.
    // amrWorkflowIdParamName is a plain string derived from the resource prefix,
    // so passing it creates no cross-stack CloudFormation dependency. This fully
    // decouples the two stacks and avoids "export in use" deadlocks when the
    // workflow definition is replaced.
    const amrWorkflowIdParamArn =
      `arn:aws:ssm:${region}:${account}:parameter${amrWorkflowIdParamName}`;

    const snsCmk        = kms.Key.fromKeyArn(this, 'SnsCmk',        snsCmkArn);
    const lambdaLogsCmk = kms.Key.fromKeyArn(this, 'LambdaLogsCmk', lambdaLogsCmkArn);
    // ── VPC (10.{slot}.0.0/16, 2 AZs, NAT Gateway) ──────────────────────────
    const vpc = new ec2.Vpc(this, 'PipelineVpc', {
      vpcName: `${resourcePrefix}-amr-pipeline-vpc`,
      ipAddresses: ec2.IpAddresses.cidr(`10.${slot}.0.0/16`),
      maxAzs: 2, natGateways: 1,
      subnetConfiguration: [
        { name: 'Public',  subnetType: ec2.SubnetType.PUBLIC,               cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,  cidrMask: 24 },
      ],
    });

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc, description: `${resourcePrefix}-amr-sra-fetcher task SG`, allowAllOutbound: true,
    });

    // ── ECS Cluster ──────────────────────────────────────────────────────────
    const ecsCluster = new ecs.Cluster(this, 'PipelineCluster', {
      clusterName: `${resourcePrefix}-amr-pipeline`, vpc, containerInsights: true,
    });

    const taskExecutionRole = new iam.Role(this, 'SraFetcherExecRole', {
      roleName: `${resourcePrefix}-amr-sra-fetcher-exec`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    // Task role: read the public SRA object (unsigned) and write to raw/ prefix.
    const taskRole = new iam.Role(this, 'SraFetcherTaskRole', {
      roleName: `${resourcePrefix}-amr-sra-fetcher-task`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      inlinePolicies: {
        DataLakeWrite: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:PutObject', 's3:GetObject'],
            resources: [`arn:aws:s3:::${dataLakeBucketName}/raw/*`],
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['s3:ListBucket'],
            resources: [`arn:aws:s3:::${dataLakeBucketName}`],
            conditions: { StringLike: { 's3:prefix': ['raw/*'] } },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
            resources: [s3DataLakeCmkArn],
          }),
        ]}),
      },
    });

    const sraFetcherLogGroup = new logs.LogGroup(this, 'SraFetcherLogGroup', {
      logGroupName: `/aws/ecs/${resourcePrefix}-amr-sra-fetcher`,
      retention: logs.RetentionDays.THREE_MONTHS,
      encryptionKey: lambdaLogsCmk,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const sraFetcherTaskDef = new ecs.FargateTaskDefinition(this, 'SraFetcherTask', {
      family: `${resourcePrefix}-amr-sra-fetcher`, cpu: 2048, memoryLimitMiB: 4096,
      // 40 GiB ephemeral scratch: the .sra download plus decompressed FASTQ can
      // be several GiB for a bacterial WGS run; the default 20 GiB is tight.
      ephemeralStorageGiB: 40,
      executionRole: taskExecutionRole, taskRole,
    });

    // The container root filesystem is read-only (FR-019), so fasterq-dump needs
    // a writable scratch mount. Back it with the task's ephemeral storage.
    sraFetcherTaskDef.addVolume({ name: 'scratch' });

    // Fargate bind mounts are created root-owned (0755), so a non-root container
    // cannot write to them. A short init container (root) chowns the shared
    // scratch volume to the runtime uid, then exits; the main container starts
    // only after it succeeds. This preserves FR-019 (main task stays non-root
    // with a read-only root filesystem) while giving fasterq-dump writable space.
    const scratchInit = sraFetcherTaskDef.addContainer('scratch-init', {
      image: ecs.ContainerImage.fromRegistry(sraToolsImageUri),
      containerName: 'scratch-init',
      essential: false,
      user: '0:0',
      readonlyRootFilesystem: true,
      entryPoint: ['/bin/sh', '-c'],
      command: ['chown 1000:1000 /tmp/fastq && chmod 0770 /tmp/fastq'],
      logging: ecs.LogDrivers.awsLogs({ logGroup: sraFetcherLogGroup, streamPrefix: 'scratch-init' }),
    });
    scratchInit.addMountPoints({
      containerPath: '/tmp/fastq', sourceVolume: 'scratch', readOnly: false,
    });

    // FR-019: Container security — non-root user, read-only root filesystem.
    // The writable scratch volume is mounted at the fasterq-dump output dir.
    const sraFetcherContainer = sraFetcherTaskDef.addContainer('sra-fetcher', {
      image: ecs.ContainerImage.fromRegistry(sraToolsImageUri),
      containerName: 'sra-fetcher',
      environment: { OUTPUT_DIR: '/tmp/fastq', AWS_DEFAULT_REGION: region, S3_OUTPUT_BUCKET: dataLakeBucketName },
      logging: ecs.LogDrivers.awsLogs({ logGroup: sraFetcherLogGroup, streamPrefix: 'sra-fetcher' }),
      user: '1000:1000',
      readonlyRootFilesystem: true,
      privileged: false,
      linuxParameters: new ecs.LinuxParameters(this, 'SraFetcherLinuxParams', {
        initProcessEnabled: true,
      }),
    });

    sraFetcherContainer.addMountPoints({
      containerPath: '/tmp/fastq', sourceVolume: 'scratch', readOnly: false,
    });

    // Main container starts only after the scratch-init chown completes.
    sraFetcherContainer.addContainerDependencies({
      container: scratchInit,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // ── Lambda helpers ───────────────────────────────────────────────────────
    const makeLg = (name: string) => new logs.LogGroup(this, `${name}Lg`, {
      logGroupName: `/aws/lambda/${resourcePrefix}-amr-${name}`,
      retention: logs.RetentionDays.THREE_MONTHS, encryptionKey: lambdaLogsCmk,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const makeDlq = (name: string) => new sqs.Queue(this, `${name}Dlq`, {
      queueName: `${resourcePrefix}-amr-${name}-dlq`,
      retentionPeriod: cdk.Duration.days(14), encryption: sqs.QueueEncryption.KMS_MANAGED,
    });

    const lambdaSrcDir = path.join(__dirname, '../../src/lambdas');
    const commonEnv = {
      DYNAMO_TABLE_NAME: dynamoTableName, DATA_LAKE_BUCKET: dataLakeBucketName,
      ATHENA_WORKGROUP: athenaWorkgroupName, ATHENA_RESULTS_BUCKET: athenaResultsBucketName,
      GLUE_DATABASE: glueDatabaseName, RESOURCE_PREFIX: resourcePrefix,
    };

    // ── ingestion-validator Lambda (FR-020/NFR-014) ──────────────────────────
    const valDlq = makeDlq('ingestion-validator');
    const valRole = new iam.Role(this, 'ValidatorRole', {
      roleName: `${resourcePrefix}-amr-ingestion-validator`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['dynamodb:PutItem', 'dynamodb:GetItem'],
          resources: [`arn:aws:dynamodb:${region}:${account}:table/${dynamoTableName}`] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [dynamoCmkArn, lambdaLogsCmkArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['sqs:SendMessage'], resources: [valDlq.queueArn] }),
      ]})},
    });

    const ingestionValidator = new lambda.Function(this, 'IngestionValidator', {
      functionName: `${resourcePrefix}-amr-ingestion-validator`,
      runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(lambdaSrcDir, 'ingestion-validator')),
      role: valRole, timeout: cdk.Duration.seconds(30), reservedConcurrentExecutions: 5,
      environment: { ...commonEnv, ALLOWED_SOURCES: 'ncbi-sra-public,ncbi-trace-public' },
      deadLetterQueue: valDlq, logGroup: makeLg('ingestion-validator'),
    });

    // ── isolate-deduper Lambda (FR-001/FR-010) ───────────────────────────────
    const dedupDlq = makeDlq('isolate-deduper');
    const dedupRole = new iam.Role(this, 'DeduperRole', {
      roleName: `${resourcePrefix}-amr-isolate-deduper`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
          resources: [`arn:aws:dynamodb:${region}:${account}:table/${dynamoTableName}`] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [dynamoCmkArn, lambdaLogsCmkArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['sqs:SendMessage'], resources: [dedupDlq.queueArn] }),
      ]})},
    });

    const isolateDeduper = new lambda.Function(this, 'IsolateDeduper', {
      functionName: `${resourcePrefix}-amr-isolate-deduper`,
      runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(lambdaSrcDir, 'isolate-deduper')),
      role: dedupRole, timeout: cdk.Duration.seconds(30), reservedConcurrentExecutions: 5,
      environment: commonEnv, deadLetterQueue: dedupDlq, logGroup: makeLg('isolate-deduper'),
    });

    // ── concordance-computer Lambda (FR-016) ─────────────────────────────────
    const concDlq = makeDlq('concordance-computer');
    const concRole = new iam.Role(this, 'ConcordanceRole', {
      roleName: `${resourcePrefix}-amr-concordance-computer`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults', 'athena:StopQueryExecution'],
          resources: [`arn:aws:athena:${region}:${account}:workgroup/${athenaWorkgroupName}`] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions'],
          resources: [
            `arn:aws:glue:${region}:${account}:catalog`,
            `arn:aws:glue:${region}:${account}:database/*`,
            `arn:aws:glue:${region}:${account}:table/*/*`,
          ] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::${athenaResultsBucketName}`, `arn:aws:s3:::${athenaResultsBucketName}/*`,
            `arn:aws:s3:::${dataLakeBucketName}`, `arn:aws:s3:::${dataLakeBucketName}/*`,
          ] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [glueCmkArn, lambdaLogsCmkArn, s3DataLakeCmkArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['sqs:SendMessage'], resources: [concDlq.queueArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['s3tables:GetTableBucket', 's3tables:ListTableBuckets', 's3tables:GetTable', 's3tables:ListTables'],
          resources: [icebergTableBucketArn, `${icebergTableBucketArn}/*`] }),
      ]})},
    });

    const concordanceComputer = new lambda.Function(this, 'ConcordanceComputer', {
      functionName: `${resourcePrefix}-amr-concordance-computer`,
      runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(lambdaSrcDir, 'concordance-computer')),
      role: concRole, timeout: cdk.Duration.minutes(10), reservedConcurrentExecutions: 5,
      environment: commonEnv, deadLetterQueue: concDlq, logGroup: makeLg('concordance-computer'),
    });

    // ── hamronization-runner Lambda (FR-005) ─────────────────────────────────
    const hamDlq = makeDlq('hamronization-runner');
    const hamRole = new iam.Role(this, 'HamronizationRole', {
      roleName: `${resourcePrefix}-amr-hamronization-runner`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: [`arn:aws:s3:::${dataLakeBucketName}`, `arn:aws:s3:::${dataLakeBucketName}/*`] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [s3DataLakeCmkArn, lambdaLogsCmkArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['sqs:SendMessage'], resources: [hamDlq.queueArn] }),
      ]})},
    });

    const hamronizationRunner = new lambda.Function(this, 'HamronizationRunner', {
      functionName: `${resourcePrefix}-amr-hamronization-runner`,
      runtime: lambda.Runtime.PYTHON_3_12, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(path.join(lambdaSrcDir, 'hamronization-runner')),
      role: hamRole, timeout: cdk.Duration.minutes(5), reservedConcurrentExecutions: 5,
      environment: commonEnv, deadLetterQueue: hamDlq, logGroup: makeLg('hamronization-runner'),
    });

    // ── Glue script + job (FR-006) ───────────────────────────────────────────
    // Note: Glue script (amr_etl.py) is pre-uploaded to s3://{dataLakeBucketName}/glue-scripts/
    // via `aws s3 cp` during deployment (BucketDeployment Lambda lacks KMS grant for data lake bucket).

    const glueJobRole = new iam.Role(this, 'GlueJobRole', {
      roleName: `${resourcePrefix}-amr-glue-etl`,
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSGlueServiceRole')],
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::${dataLakeBucketName}`, `arn:aws:s3:::${dataLakeBucketName}/*`,
            `arn:aws:s3:::${athenaResultsBucketName}`, `arn:aws:s3:::${athenaResultsBucketName}/*`,
          ] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey', 'kms:ReEncrypt*', 'kms:CreateGrant'],
          // s3TablesCmkArn: the Iceberg tables are encrypted with the S3 Tables
          // CMK; the S3 Tables catalog client must decrypt table metadata + data.
          resources: [glueCmkArn, s3DataLakeCmkArn, s3TablesCmkArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['glue:GetTable', 'glue:GetDatabase', 'glue:GetPartitions', 'glue:UpdateTable'],
          resources: [
            `arn:aws:glue:${region}:${account}:catalog`,
            `arn:aws:glue:${region}:${account}:database/*`,
            `arn:aws:glue:${region}:${account}:table/*/*`,
          ] }),
        // The Amazon S3 Tables Catalog for Apache Iceberg client talks directly
        // to the S3 Tables API for namespace/table discovery and read/write, so
        // the job role needs the full s3tables action set on the table bucket.
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: [
            's3tables:GetTableBucket', 's3tables:ListTableBuckets',
            's3tables:GetNamespace', 's3tables:ListNamespaces', 's3tables:CreateNamespace',
            's3tables:GetTable', 's3tables:ListTables', 's3tables:CreateTable', 's3tables:UpdateTable',
            's3tables:GetTableData', 's3tables:PutTableData',
            's3tables:GetTableMetadataLocation', 's3tables:UpdateTableMetadataLocation',
            's3tables:GetTableMaintenanceConfiguration',
          ],
          resources: [icebergTableBucketArn, `${icebergTableBucketArn}/*`] }),
        // Required when Lake Formation is enforced for the catalog.
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['lakeformation:GetDataAccess'], resources: ['*'] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: [`arn:aws:logs:${region}:${account}:log-group:/aws-glue/*`] }),
      ]})},
    });

    // GlueVersion=5.0, WorkerType=G.1X, command.name=glueetl (PySpark, NOT Ray)
    new glue.CfnJob(this, 'AmrEtlJob', {
      name: `${resourcePrefix}-amr-etl`,
      description: 'FR-006: hAMRonization TSV to Iceberg amr_profiles and isolate_metadata',
      role: glueJobRole.roleArn, glueVersion: '5.0', workerType: 'G.1X', numberOfWorkers: 2,
      maxRetries: 1, timeout: 60,
      command: {
        name: 'glueetl', pythonVersion: '3',
        scriptLocation: `s3://${dataLakeBucketName}/glue-scripts/amr_etl.py`,
      },
      defaultArguments: {
        '--job-language': 'python',
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-structured-logging': 'true',
        '--enable-glue-datacatalog': 'true',
        '--TempDir': `s3://${dataLakeBucketName}/glue-tmp/`,
        '--spark-event-logs-path': `s3://${dataLakeBucketName}/glue-spark-logs/`,
        // S3 Tables are accessed from Spark using the Amazon S3 Tables Catalog
        // for Apache Iceberg client (catalog name 's3tablesbucket'), the
        // purpose-built, documented path. It talks directly to the S3 Tables API
        // (gated by the s3tables:* + S3 Tables CMK grants on the job role), which
        // avoids the Glue-federation / Iceberg-REST catalog-id ambiguity. The
        // client JAR is provided via --extra-jars (synced to the data lake by the
        // deploy script). Catalog settings must be applied at Spark session
        // startup, so they are passed as a single space-separated --conf value.
        // Tables resolve as s3tablesbucket.amr_db.<table>.
        '--extra-jars': `s3://${dataLakeBucketName}/glue-jars/s3-tables-catalog-runtime.jar`,
        '--conf': [
          'spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions',
          '--conf spark.sql.catalog.s3tablesbucket=org.apache.iceberg.spark.SparkCatalog',
          '--conf spark.sql.catalog.s3tablesbucket.catalog-impl=software.amazon.s3tables.iceberg.S3TablesCatalog',
          `--conf spark.sql.catalog.s3tablesbucket.warehouse=${icebergTableBucketArn}`,
          `--conf spark.sql.catalog.s3tablesbucket.client.region=${region}`,
        ].join(' '),
        '--harmonized_key': 'harmonized/PLACEHOLDER/PLACEHOLDER/hamronization.tsv',
        '--harmonized_bucket': dataLakeBucketName,
        '--isolate_id': 'PLACEHOLDER',
        '--run_id': runId, '--glue_catalog_db': glueDatabaseName,
        '--data_lake_bucket': dataLakeBucketName,
        '--organism': 'Salmonella',
        '--sra_accession': 'PLACEHOLDER',
        '--source_provenance': 'NCBI SRA Public',
        '--license': 'US Government public domain (NCBI SRA)',
      },
      executionProperty: { maxConcurrentRuns: 10 },
      tags: { 'apex:run-id': runId, 'apex:prefix': resourcePrefix },
    });

    // ── SNS Topic (KMS encrypted) ────────────────────────────────────────────
    const notificationsTopic = new sns.Topic(this, 'NotificationsTopic', {
      topicName: `${resourcePrefix}-amr-pipeline-notifications`,
      masterKey: snsCmk, displayName: `${resourcePrefix} AMR Pipeline Notifications`,
    });
    this.snsTopicArn = notificationsTopic.topicArn;

    // ── Step Functions IAM role ──────────────────────────────────────────────
    const sfnRole = new iam.Role(this, 'StateMachineRole', {
      roleName: `${resourcePrefix}-amr-pipeline-sfn`,
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['lambda:InvokeFunction'],
          resources: [ingestionValidator.functionArn, isolateDeduper.functionArn,
            hamronizationRunner.functionArn, concordanceComputer.functionArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['ecs:RunTask'],
          resources: [sraFetcherTaskDef.taskDefinitionArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['ecs:StopTask', 'ecs:DescribeTasks'],
          resources: ['*'] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['iam:PassRole'],
          resources: [taskRole.roleArn, taskExecutionRole.roleArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['omics:StartRun', 'omics:GetRun', 'omics:ListRuns'], resources: ['*'] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter'], resources: [amrWorkflowIdParamArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['iam:PassRole'],
          resources: [omicsServiceRoleArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['glue:StartJobRun', 'glue:GetJobRun', 'glue:GetJob', 'glue:BatchStopJobRun'],
          resources: [`arn:aws:glue:${region}:${account}:job/${resourcePrefix}-amr-etl`] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['sns:Publish'],
          resources: [notificationsTopic.topicArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey'],
          resources: [snsCmkArn, glueCmkArn] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['events:PutTargets', 'events:PutRule', 'events:DescribeRule'],
          resources: [`arn:aws:events:${region}:${account}:rule/StepFunctionsGetEventsForECSTaskRule`] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
            'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutLogEvents',
            'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'],
          resources: ['*'] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'], resources: ['*'] }),
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW,
          actions: ['ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:DescribeVpcs'],
          resources: ['*'] }),
      ]})},
    });

    const sfnLogGroup = new logs.LogGroup(this, 'SfnLogGroup', {
      logGroupName: `/aws/states/${resourcePrefix}-amr-pipeline`,
      retention: logs.RetentionDays.THREE_MONTHS, encryptionKey: lambdaLogsCmk,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Step Functions state machine definition ──────────────────────────────
    // Per-isolate stages (inside Map, MaxConcurrency=10):
    //   ingestion-validator -> isolate-deduper -> (if dup: skip) ->
    //   ECS sra-fetcher (RUN_JOB, fetch FASTQ from AWS Open Data SRA) ->
    //   omics:startRun (merged AMR workflow: fastp -> SKESA -> AMRFinderPlus) ->
    //   poll run -> hamronization-runner -> Glue ETL (RUN_JOB) -> concordance
    // Then: SNS success publish.
    // Catch on batch Map: SNS failure publish with error context.

    const validateTask = new sfnTasks.LambdaInvoke(this, 'ValidateIngestion', {
      lambdaFunction: ingestionValidator, resultPath: '$.validation',
      payloadResponseOnly: true, retryOnServiceExceptions: true,
    });

    const dedupeTask = new sfnTasks.LambdaInvoke(this, 'DeduplicateIsolate', {
      lambdaFunction: isolateDeduper, resultPath: '$.dedup',
      payloadResponseOnly: true, retryOnServiceExceptions: true,
    });

    const skipDuplicate = new sfn.Pass(this, 'SkipDuplicate',
      { result: sfn.Result.fromObject({ skipped: true }), resultPath: '$.dedup' });

    // STANDARD workflow: wait for the Fargate SRA fetch to complete before
    // proceeding to the genomics run (ecs:runTask.sync / RUN_JOB).
    const sraFetcherTask = new sfnTasks.EcsRunTask(this, 'RunSraFetcher', {
      cluster: ecsCluster, taskDefinition: sraFetcherTaskDef,
      launchTarget: new sfnTasks.EcsFargateLaunchTarget(),
      assignPublicIp: false, securityGroups: [ecsSg],
      subnets: { subnets: vpc.privateSubnets },
      containerOverrides: [{ containerDefinition: sraFetcherContainer,
        environment: [
          { name: 'SRA_ACCESSION', value: sfn.JsonPath.stringAt('$.accession') },
          { name: 'ISOLATE_ID',    value: sfn.JsonPath.stringAt('$.isolate_id') },
          { name: 'S3_OUTPUT_BUCKET', value: dataLakeBucketName },
        ] }],
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      resultPath: '$.sraFetch',
    });

    // Build the run inputs: paired-end FASTQ S3 URIs (written by the fetcher to
    // raw/<isolate_id>/<accession>_{1,2}.fastq.gz), a per-run output prefix, and
    // the two container image URIs the workflow needs.
    const prepAmrInput = new sfn.Pass(this, 'PrepAmrInput', {
      parameters: {
        'isolate_id.$': '$.isolate_id',
        'run_id.$': '$.run_id',
        'accession.$': '$.accession',
        'source_provenance.$': '$.source_provenance',
        'license.$': '$.license',
        // No '.$' suffix -> CDK adds it automatically for JsonPath intrinsics.
        // HealthOmics validates each S3-URI parameter as a single object before
        // the run starts, so R1 and R2 are passed as separate parameters.
        read1: sfn.JsonPath.format(
          `s3://${dataLakeBucketName}/raw/{}/{}_1.fastq.gz`,
          sfn.JsonPath.stringAt('$.isolate_id'), sfn.JsonPath.stringAt('$.accession')),
        read2: sfn.JsonPath.format(
          `s3://${dataLakeBucketName}/raw/{}/{}_2.fastq.gz`,
          sfn.JsonPath.stringAt('$.isolate_id'), sfn.JsonPath.stringAt('$.accession')),
        amrOutputUri: sfn.JsonPath.format(
          `s3://${dataLakeBucketName}/omics-output/{}/{}/`,
          sfn.JsonPath.stringAt('$.run_id'), sfn.JsonPath.stringAt('$.isolate_id')),
        amrOutputPrefix: sfn.JsonPath.format(
          'omics-output/{}/{}/',
          sfn.JsonPath.stringAt('$.run_id'), sfn.JsonPath.stringAt('$.isolate_id')),
        runName: sfn.JsonPath.format('amr-{}', sfn.JsonPath.stringAt('$.isolate_id')),
      },
    });

    // Read the HealthOmics workflow id from SSM at execution time.
    const getWorkflowId = new sfnTasks.CallAwsService(this, 'GetAmrWorkflowId', {
      service: 'ssm', action: 'getParameter',
      parameters: { Name: amrWorkflowIdParamName },
      iamResources: [amrWorkflowIdParamArn],
      resultPath: '$.workflowIdParam',
    });

    const startAmrRun = new sfnTasks.CallAwsService(this, 'StartAmrRun', {
      service: 'omics', action: 'startRun',
      parameters: {
        'WorkflowId.$': '$.workflowIdParam.Parameter.Value',
        WorkflowType: 'PRIVATE',
        RoleArn: omicsServiceRoleArn,
        'OutputUri.$': '$.amrOutputUri',
        'Name.$': '$.runName',
        StorageType: 'DYNAMIC',
        LogLevel: 'ALL',
        'RequestId.$': '$.run_id',
        Parameters: {
          'read1.$': '$.read1',
          'read2.$': '$.read2',
          'isolate_id.$': '$.isolate_id',
          organism: 'Salmonella',
          assembly_container: assemblyContainerImageUri,
          amr_container: amrContainerImageUri,
        },
      },
      iamResources: ['*'], resultPath: '$.amrRun',
    });

    const waitAmr = new sfn.Wait(this, 'WaitAmr', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(60)),
    });

    const pollAmr = new sfnTasks.CallAwsService(this, 'GetAmrRunStatus', {
      service: 'omics', action: 'getRun',
      parameters: { 'Id.$': '$.amrRun.Id' },
      iamResources: ['*'], resultPath: '$.amrStatus',
    });

    const amrFailState = new sfn.Fail(this, 'AmrRunFailed',
      { error: 'AmrRunFailed', cause: 'HealthOmics AMR genomics run failed' });

    // hAMRonization: discover the AMRFinderPlus TSV under the run output prefix.
    const prepHamrInput = new sfn.Pass(this, 'PrepHamrInput', {
      parameters: {
        'isolate_id.$': '$.isolate_id', 'run_id.$': '$.run_id',
        'accession.$': '$.accession', 'source_provenance.$': '$.source_provenance',
        'license.$': '$.license',
        'amr_output_prefix.$': '$.amrOutputPrefix',
        data_lake_bucket: dataLakeBucketName,
        organism: 'Salmonella',
      },
    });

    const hamronizationTask = new sfnTasks.LambdaInvoke(this, 'RunHamronization', {
      lambdaFunction: hamronizationRunner, resultPath: '$.hamronization',
      payloadResponseOnly: true, retryOnServiceExceptions: true,
    });

    const glueEtlTask = new sfnTasks.GlueStartJobRun(this, 'RunGlueEtl', {
      glueJobName: `${resourcePrefix}-amr-etl`,
      integrationPattern: sfn.IntegrationPattern.RUN_JOB,
      arguments: sfn.TaskInput.fromObject({
        '--harmonized_key.$': '$.hamronization.harmonized_key',
        '--harmonized_bucket.$': '$.hamronization.harmonized_bucket',
        '--isolate_id.$': '$.isolate_id', '--run_id.$': '$.run_id',
        '--sra_accession.$': '$.accession',
        '--source_provenance.$': '$.source_provenance',
        '--license.$': '$.license',
        '--glue_catalog_db': glueDatabaseName, '--data_lake_bucket': dataLakeBucketName,
        '--organism': 'Salmonella',
      }),
      resultPath: '$.glueEtl',
    });

    const concordanceTask = new sfnTasks.LambdaInvoke(this, 'ComputeConcordance', {
      lambdaFunction: concordanceComputer, resultPath: '$.concordance',
      payloadResponseOnly: true, retryOnServiceExceptions: true,
    });

    // Execution.Name lives in the Step Functions context object ($$), not the
    // state input ($). Referencing $.Execution.Name fails at runtime.
    const successPublish = new sfnTasks.SnsPublish(this, 'PublishSuccess', {
      topic: notificationsTopic,
      message: sfn.TaskInput.fromObject({
        'run_id.$': '$$.Execution.Name', 'status': 'COMPLETED',
        'message': 'AMR pipeline batch completed successfully',
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    const addErrCtx = new sfn.Pass(this, 'AddErrorContext', {
      parameters: {
        'error.$': '$.Error', 'cause.$': '$.Cause',
        'stage': 'pipeline', 'run_id.$': '$$.Execution.Name',
      },
    });

    const failurePublish = new sfnTasks.SnsPublish(this, 'PublishFailure', {
      topic: notificationsTopic,
      message: sfn.TaskInput.fromObject({
        'run_id.$': '$.run_id', 'status': 'FAILED',
        'error.$': '$.error', 'cause.$': '$.cause', 'stage.$': '$.stage',
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Post-run chain: hamronization -> Glue ETL -> concordance.
    const postRunChain = sfn.Chain
      .start(prepHamrInput)
      .next(hamronizationTask)
      .next(glueEtlTask)
      .next(concordanceTask);

    // AMR run poll loop: wait -> poll -> choice; the choice loops back to wait
    // until the run reaches a terminal status. A Choice must be the end of its
    // chain, so the loop is wired explicitly rather than via .next().
    const amrChoice = new sfn.Choice(this, 'AmrRunComplete')
      .when(sfn.Condition.stringEquals('$.amrStatus.Status', 'COMPLETED'), postRunChain)
      .when(sfn.Condition.stringEquals('$.amrStatus.Status', 'FAILED'), amrFailState)
      .when(sfn.Condition.stringEquals('$.amrStatus.Status', 'CANCELLED'), amrFailState)
      .otherwise(waitAmr);
    waitAmr.next(pollAmr);
    pollAmr.next(amrChoice);

    // Main processing chain: sra-fetcher -> prepAmrInput -> getWorkflowId ->
    // startRun -> wait loop.
    const processingChain = sfn.Chain
      .start(sraFetcherTask)
      .next(prepAmrInput)
      .next(getWorkflowId)
      .next(startAmrRun)
      .next(waitAmr);

    // Per-isolate chain with dedup gate.
    const perIsolateChain = sfn.Chain
      .start(validateTask)
      .next(dedupeTask)
      .next(new sfn.Choice(this, 'IsDuplicate')
        .when(sfn.Condition.booleanEquals('$.dedup.skipped', true), skipDuplicate)
        .otherwise(processingChain));

    // Map state over $.isolates with MaxConcurrency=10.
    const batchMap = new sfn.Map(this, 'ProcessIsolateBatch', {
      maxConcurrency: 10, itemsPath: sfn.JsonPath.stringAt('$.isolates'), resultPath: '$.results',
    });
    batchMap.itemProcessor(perIsolateChain);
    batchMap.addCatch(addErrCtx.next(failurePublish), { errors: ['States.ALL'], resultPath: '$' });

    // FR-009: pipeline orchestration uses a Step Functions STANDARD workflow.
    // The pipeline runs a synchronous HealthOmics workflow run (assembly + AMR
    // screening, ~15-30 min) plus a synchronous Glue ETL, so the run can span
    // hours. EXPRESS workflows are capped at 5 minutes and do not support the
    // DescribeExecution / ListExecutions APIs used by the REST API, so STANDARD
    // is required for correctness.
    const stateMachine = new sfn.StateMachine(this, 'AmrPipeline', {
      stateMachineName: `${resourcePrefix}-amr-pipeline`,
      definitionBody: sfn.DefinitionBody.fromChainable(batchMap.next(successPublish)),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: cdk.Duration.hours(48),
      role: sfnRole,
      logs: { destination: sfnLogGroup, level: sfn.LogLevel.ALL, includeExecutionData: true },
      tracingEnabled: true,
    });
    this.stateMachineArn = stateMachine.stateMachineArn;

    // ── EventBridge Scheduler — weekly Mon 06:00 UTC ─────────────────────────
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `${resourcePrefix}-amr-pipeline-scheduler`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      inlinePolicies: { P: new iam.PolicyDocument({ statements: [
        new iam.PolicyStatement({ effect: iam.Effect.ALLOW, actions: ['states:StartExecution'],
          resources: [stateMachine.stateMachineArn] }),
      ]})},
    });

    // Default weekly payload uses real public GenomeTrakr Salmonella accessions
    // from the AWS Open Data SRA mirror. run_id is stamped at trigger time by
    // the scheduler input; the isolate-deduper skips isolates already processed.
    const defaultPayload = {
      isolates: [
        { isolate_id: 'isolate-SRR1583085', accession: 'SRR1583085', source: 'ncbi-sra-public',
          source_provenance: 'NCBI SRA Public', license: 'US Government public domain (NCBI SRA)',
          run_id: `weekly-${runId}` },
      ],
      run_id: `weekly-${runId}`,
      triggeredBy: 'scheduler',
    };

    new scheduler.CfnSchedule(this, 'WeeklySchedule', {
      name: `${resourcePrefix}-amr-weekly`,
      description: `${resourcePrefix} AMR weekly pipeline trigger Mon 06:00 UTC`,
      scheduleExpression: 'cron(0 6 ? * MON *)', scheduleExpressionTimezone: 'UTC',
      state: 'ENABLED', flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: stateMachine.stateMachineArn, roleArn: schedulerRole.roleArn,
        input: JSON.stringify(defaultPayload),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    // ── SSM + Outputs ────────────────────────────────────────────────────────
    const ns = `/${resourcePrefix}/amr/pipeline`;
    new ssm.StringParameter(this, 'SsmSmArn', { parameterName: `${ns}/state-machine-arn`, stringValue: stateMachine.stateMachineArn });
    new ssm.StringParameter(this, 'SsmSnsTopic', { parameterName: `${ns}/sns-topic-arn`, stringValue: notificationsTopic.topicArn });
    new ssm.StringParameter(this, 'SsmGlueJob', { parameterName: `${ns}/glue-job-name`, stringValue: `${resourcePrefix}-amr-etl` });
    new ssm.StringParameter(this, 'SsmVpcId', { parameterName: `${ns}/vpc-id`, stringValue: vpc.vpcId });

    new cdk.CfnOutput(this, 'StateMachineArn', { value: stateMachine.stateMachineArn, exportName: `${resourcePrefix}-amr-pipeline-state-machine-arn` });
    new cdk.CfnOutput(this, 'SnsTopicArn',     { value: notificationsTopic.topicArn,   exportName: `${resourcePrefix}-amr-pipeline-sns-topic-arn`   });
    new cdk.CfnOutput(this, 'GlueJobName',     { value: `${resourcePrefix}-amr-etl`,   exportName: `${resourcePrefix}-amr-glue-job-name`            });
    new cdk.CfnOutput(this, 'EcsClusterArn',   { value: ecsCluster.clusterArn,         exportName: `${resourcePrefix}-amr-ecs-cluster-arn`          });
    new cdk.CfnOutput(this, 'VpcId',           { value: vpc.vpcId,                     exportName: `${resourcePrefix}-amr-pipeline-vpc-id`          });
  }
}
