import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3tables from 'aws-cdk-lib/aws-s3tables';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
  /** ARN of the S3 Data Lake CMK (from FoundationStack) */
  s3DataLakeKeyArn: string;
  /** ARN of the S3 Tables CMK (from FoundationStack) */
  s3TablesKeyArn: string;
  /** ARN of the DynamoDB CMK (from FoundationStack) */
  dynamoKeyArn: string;
}

export class StorageStack extends cdk.Stack {
  public readonly dataLakeBucket: s3.Bucket;
  public readonly athenaResultsBucket: s3.Bucket;
  public readonly isolateStateTable: dynamodb.Table;
  public readonly icebergTableBucketArn: string;
  public readonly glueDatabaseName: string;
  public readonly athenaWorkgroupName: string;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { resourcePrefix, s3DataLakeKeyArn, s3TablesKeyArn, dynamoKeyArn } = props;

    // Import the KMS keys by ARN (resolved literal strings from app.ts).
    const s3DataLakeKey = kms.Key.fromKeyArn(this, 's3-data-lake-key', s3DataLakeKeyArn);
    const dynamoKey     = kms.Key.fromKeyArn(this, 'dynamo-key',      dynamoKeyArn);

    // ── (a) S3 Genomics Data Lake Bucket ───────────────────────────────────
    this.dataLakeBucket = new s3.Bucket(this, 'data-lake-bucket', {
      bucketName: `${resourcePrefix}-amr-data-lake`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: s3DataLakeKey,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'archive-raw-to-glacier-ir',
          prefix: 'raw/',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
        },
      ],
    });

    // ── (b) S3 Tables Bucket (Iceberg) ─────────────────────────────────────
    // Per runbook Pattern 3: the S3 Tables CMK must have a key-policy statement
    // allowing maintenance.s3tables.amazonaws.com for kms:Decrypt +
    // kms:GenerateDataKey. This is patched into the FoundationStack key policy
    // so that managed compaction can access encrypted tables.
    // NOTE: "-amr-iceberg" was locked in a transitional deletion state from a
    // prior deploy attempt. Using "-amr-iceberg-tbl" to avoid the conflict.
    const icebergTableBucketName = `${resourcePrefix}-amr-iceberg-tbl`;

    const icebergTableBucket = new s3tables.CfnTableBucket(this, 'iceberg-table-bucket', {
      tableBucketName: icebergTableBucketName,
      encryptionConfiguration: {
        sseAlgorithm: 'aws:kms',
        kmsKeyArn: s3TablesKeyArn,
      },
    });

    this.icebergTableBucketArn = icebergTableBucket.attrTableBucketArn;

    // Namespace: amr_db
    const icebergNamespace = new s3tables.CfnNamespace(this, 'iceberg-namespace', {
      tableBucketArn: icebergTableBucket.attrTableBucketArn,
      namespace: 'amr_db',
    });
    icebergNamespace.addDependency(icebergTableBucket);

    // Helper: create an Iceberg V2 table
    const makeIcebergTable = (
      constructId: string,
      tableName: string,
      fields: s3tables.CfnTable.SchemaFieldProperty[],
      partitionSpec?: s3tables.CfnTable.IcebergPartitionSpecProperty,
    ): s3tables.CfnTable => {
      const table = new s3tables.CfnTable(this, constructId, {
        tableBucketArn: icebergTableBucket.attrTableBucketArn,
        namespace: 'amr_db',
        tableName,
        openTableFormat: 'ICEBERG',
        icebergMetadata: {
          icebergSchema: {
            schemaFieldList: fields,
          },
          icebergPartitionSpec: partitionSpec,
          tableProperties: {
            'format-version': '2',
          },
        },
      });
      table.addDependency(icebergNamespace);
      return table;
    };

    // Table 1: amr_profiles
    // Partition spec: identity(organism) + bucket(isolate_id, 16)
    // Field IDs: isolate_id=1, gene_id=2, gene_name=3, detection_tool=4,
    //            confidence=5, organism=6, run_id=7, ts=8
    const amrProfilesFields: s3tables.CfnTable.SchemaFieldProperty[] = [
      { id: 1, name: 'isolate_id',     type: 'string',    required: false },
      { id: 2, name: 'gene_id',        type: 'string',    required: false },
      { id: 3, name: 'gene_name',      type: 'string',    required: false },
      { id: 4, name: 'detection_tool', type: 'string',    required: false },
      { id: 5, name: 'confidence',     type: 'double',    required: false },
      { id: 6, name: 'organism',       type: 'string',    required: false },
      { id: 7, name: 'run_id',         type: 'string',    required: false },
      { id: 8, name: 'ts',             type: 'timestamp', required: false },
    ];

    makeIcebergTable(
      'amr-profiles-table',
      'amr_profiles',
      amrProfilesFields,
      {
        specId: 0,
        fields: [
          // identity transform on organism (source field id 6)
          { fieldId: 1000, name: 'organism',       sourceId: 6, transform: 'identity' },
          // bucket(isolate_id, 16) — source field id 1
          { fieldId: 1001, name: 'isolate_id_bucket', sourceId: 1, transform: 'bucket[16]' },
        ],
      },
    );

    // Table 2: isolate_metadata
    const isolateMetadataFields: s3tables.CfnTable.SchemaFieldProperty[] = [
      { id: 1, name: 'isolate_id',        type: 'string',    required: false },
      { id: 2, name: 'organism',          type: 'string',    required: false },
      { id: 3, name: 'sra_accession',     type: 'string',    required: false },
      { id: 4, name: 'source_provenance', type: 'string',    required: false },
      { id: 5, name: 'license',           type: 'string',    required: false },
      { id: 6, name: 'ingestion_ts',      type: 'timestamp', required: false },
    ];

    makeIcebergTable('isolate-metadata-table', 'isolate_metadata', isolateMetadataFields);

    // Table 3: ast_phenotypes
    const astPhenotypesFields: s3tables.CfnTable.SchemaFieldProperty[] = [
      { id: 1, name: 'isolate_id',      type: 'string', required: false },
      { id: 2, name: 'drug_class',      type: 'string', required: false },
      { id: 3, name: 'mic',             type: 'string', required: false },
      { id: 4, name: 'interpretation',  type: 'string', required: false },
      { id: 5, name: 'source',          type: 'string', required: false },
    ];

    makeIcebergTable('ast-phenotypes-table', 'ast_phenotypes', astPhenotypesFields);

    // ── (c) S3 Athena Results Bucket ───────────────────────────────────────
    this.athenaResultsBucket = new s3.Bucket(this, 'athena-results-bucket', {
      bucketName: `${resourcePrefix}-amr-athena-results`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: s3DataLakeKey,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-athena-results',
          enabled: true,
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    // ── (d) DynamoDB Table ─────────────────────────────────────────────────
    /**
     * Conditional-write deduplication pattern for ingestion Lambda:
     *
     * Each isolate event is written with a condition expression:
     *   `attribute_not_exists(isolate_id) OR event_ts < :new_ts`
     *
     * On first write the item is created; on retry with the same event_ts,
     * DynamoDB throws ConditionalCheckFailedException (the Lambda swallows it).
     * This ensures exactly-once semantics without a separate deduplication
     * table, exploiting the composite PK (isolate_id + event_ts) to store
     * the full event history while preventing duplicate ingest.
     *
     * For the GSI run_id-index: the Lambda queries it to retrieve all events
     * for a given pipeline run, enabling per-run status aggregation.
     */
    this.isolateStateTable = new dynamodb.Table(this, 'isolate-state-table', {
      tableName: `${resourcePrefix}-amr-isolate-state`,
      partitionKey: { name: 'isolate_id', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'event_ts',   type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: dynamoKey,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.isolateStateTable.addGlobalSecondaryIndex({
      indexName: 'run_id-index',
      partitionKey: { name: 'run_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── (e) Glue Catalog for S3 Tables federation ──────────────────────────
    // S3 Tables requires catalog-level (not database-level) federation via
    // AWS::Glue::Catalog with federatedCatalog pointing to the table-bucket ARN.
    // AWS::Glue::Database with federatedDatabase is NOT supported for S3 Tables.
    // The catalog name uses the table-bucket name (underscores, not hyphens).
    this.glueDatabaseName = `${resourcePrefix}_amr_db`;

    const glueCatalog = new glue.CfnCatalog(this, 'amr-glue-catalog', {
      name: this.glueDatabaseName,
      federatedCatalog: {
        identifier: icebergTableBucket.attrTableBucketArn,
        connectionName: 'aws:s3tables',
      },
    });
    // AWS::Glue::Catalog (Data Catalog root catalog) does NOT support TagResource /
    // UntagResource API calls — Glue returns InternalServiceException 500 on every
    // attempt. CDK's global tag manager adds apex:cost-center / apex:run-id / apex:prefix,
    // but the currently-deployed resource was created with only apex:prefix and
    // apex:run-id=test-run (no cost-center). Any diff causes a tag API call → 500.
    //
    // Fix: strip all CDK-managed tags then hard-freeze the Tags property to exactly
    // the values that are already live on the resource. CloudFormation will compute
    // no diff and never call TagResource or UntagResource.
    cdk.Tags.of(glueCatalog).remove('apex:cost-center');
    cdk.Tags.of(glueCatalog).remove('apex:run-id');
    cdk.Tags.of(glueCatalog).remove('apex:prefix');
    glueCatalog.addPropertyOverride('Tags', [
      { Key: 'apex:prefix', Value: props.resourcePrefix },
      { Key: 'apex:run-id', Value: 'test-run' },
    ]);

    // ── (f) Athena Workgroup ────────────────────────────────────────────────
    // NOTE (athena runbook Pattern 4): SSE-KMS workgroups with enforced
    // configuration block Athena DML (INSERT/UPDATE/DELETE/MERGE) on SSE-KMS
    // S3 Tables. This workgroup is for SELECT queries only. Use Spark/Glue
    // or a separate non-enforced workgroup for write operations on S3 Tables.
    this.athenaWorkgroupName = `${resourcePrefix}-amr-wg`;

    new athena.CfnWorkGroup(this, 'amr-athena-wg', {
      name: this.athenaWorkgroupName,
      description: `${resourcePrefix} AMR Athena workgroup`,
      workGroupConfiguration: {
        bytesScannedCutoffPerQuery: 10737418240, // 10 GB
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${this.athenaResultsBucket.bucketName}/`,
          encryptionConfiguration: {
            encryptionOption: 'SSE_KMS',
            kmsKey: s3DataLakeKeyArn,
          },
        },
      },
    });

    // ── SSM parameter exports ──────────────────────────────────────────────
    const storageNs = `/${resourcePrefix}/amr/storage`;

    new ssm.StringParameter(this, 'ssm-data-lake-bucket', {
      parameterName: `${storageNs}/data-lake-bucket-name`,
      stringValue: this.dataLakeBucket.bucketName,
    });
    new ssm.StringParameter(this, 'ssm-iceberg-bucket-arn', {
      parameterName: `${storageNs}/iceberg-table-bucket-arn`,
      stringValue: icebergTableBucket.attrTableBucketArn,
    });
    new ssm.StringParameter(this, 'ssm-athena-results-bucket', {
      parameterName: `${storageNs}/athena-results-bucket-name`,
      stringValue: this.athenaResultsBucket.bucketName,
    });
    new ssm.StringParameter(this, 'ssm-dynamo-table-name', {
      parameterName: `${storageNs}/dynamo-table-name`,
      stringValue: this.isolateStateTable.tableName,
    });
    new ssm.StringParameter(this, 'ssm-athena-wg-name', {
      parameterName: `${storageNs}/athena-workgroup-name`,
      stringValue: this.athenaWorkgroupName,
    });
    new ssm.StringParameter(this, 'ssm-glue-db-name', {
      parameterName: `${storageNs}/glue-database-name`,
      stringValue: this.glueDatabaseName,
    });

    // ── CloudFormation Outputs ─────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DataLakeBucketName', {
      value: this.dataLakeBucket.bucketName,
      exportName: `${resourcePrefix}-data-lake-bucket-name`,
    });
    new cdk.CfnOutput(this, 'IcebergTableBucketName', {
      value: icebergTableBucketName,
      exportName: `${resourcePrefix}-iceberg-table-bucket-name`,
    });
    new cdk.CfnOutput(this, 'IcebergTableBucketArn', {
      value: icebergTableBucket.attrTableBucketArn,
      exportName: `${resourcePrefix}-iceberg-table-bucket-arn`,
    });
    new cdk.CfnOutput(this, 'AthenaResultsBucketName', {
      value: this.athenaResultsBucket.bucketName,
      exportName: `${resourcePrefix}-athena-results-bucket-name`,
    });
    new cdk.CfnOutput(this, 'DynamoTableName', {
      value: this.isolateStateTable.tableName,
      exportName: `${resourcePrefix}-dynamo-table-name`,
    });
    new cdk.CfnOutput(this, 'AthenaWorkgroupName', {
      value: this.athenaWorkgroupName,
      exportName: `${resourcePrefix}-athena-workgroup-name`,
    });
    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: this.glueDatabaseName,
      exportName: `${resourcePrefix}-glue-database-name`,
    });
  }
}
