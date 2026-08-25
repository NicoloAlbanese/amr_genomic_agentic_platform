import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as omics from 'aws-cdk-lib/aws-omics';
import * as s3Assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export interface GenomicsStackProps extends cdk.StackProps {
  resourcePrefix: string;
  runId: string;
  slot: string;
  /**
   * ARN of the HealthOmics CMK (passed from FoundationStack via env var or literal ARN).
   * Resolved in app.ts from HEALTH_OMICS_CMK_ARN env var.
   */
  healthOmicsCmkArn: string;
  /**
   * ARN of the S3 Data Lake CMK (passed from FoundationStack via env var or literal ARN).
   * Resolved in app.ts from S3_DATA_LAKE_KEY_ARN env var.
   */
  s3DataLakeCmkArn: string;
}

/**
 * GenomicsStack — AWS HealthOmics PRIVATE workflow for AMR genomics.
 *
 * Creates one workflow that chains the full analysis in a single run:
 *  ${resourcePrefix}-amr-genomics — fastp QC -> SKESA assembly -> AMRFinderPlus
 *
 * A single workflow (rather than separate assembly and screening runs) lets the
 * assembled contigs flow to AMR screening through Nextflow channels, avoiding a
 * brittle S3 hand-off between two HealthOmics runs. The workflow:
 *  - Receives container image URIs as run parameters (account/Region agnostic)
 *  - Uses HealthOmics CMK encryption
 *  - Parameterises organism (default: Salmonella)
 *  - Is deployed via aws_omics.CfnWorkflow with a definition zip S3 URI
 *
 * Addresses: FR-007, FR-008, NFR-010
 */
export class GenomicsStack extends cdk.Stack {
  /** ARN of the HealthOmics service role (cross-stack reference). */
  public readonly omicsServiceRoleArn: string;
  /** ARN of the merged AMR genomics workflow (cross-stack reference). */
  public readonly amrWorkflowArn: string;
  /** Physical id of the merged AMR genomics workflow (deploy-time token). */
  public readonly amrWorkflowId: string;
  /** SSM parameter name holding the workflow id (consumed by PipelineStack). */
  public readonly amrWorkflowIdParamName: string;

  constructor(scope: Construct, id: string, props: GenomicsStackProps) {
    super(scope, id, props);

    const { resourcePrefix, runId, healthOmicsCmkArn, s3DataLakeCmkArn } = props;

    const account = this.account;
    const region  = this.region;

    const dataLakeBucketArn = `arn:aws:s3:::${resourcePrefix}-amr-data-lake`;
    const paramNamespace    = `/${resourcePrefix}/amr`;

    // ── KMS key import ──────────────────────────────────────────────────────
    const healthOmicsKey = kms.Key.fromKeyArn(this, 'HealthOmicsKey', healthOmicsCmkArn);

    // ── IAM Role for HealthOmics Service ───────────────────────────────────
    // HealthOmics assumes this role to access S3, ECR, CloudWatch, and KMS.
    const omicsRole = new iam.Role(this, 'OmicsServiceRole', {
      roleName: `${resourcePrefix}-amr-omics-service-role`,
      assumedBy: new iam.ServicePrincipal('omics.amazonaws.com'),
      description: `${resourcePrefix} AMR HealthOmics service role`,
      inlinePolicies: {
        OmicsAccess: new iam.PolicyDocument({
          statements: [
            // S3 access to the data lake bucket for input/output
            new iam.PolicyStatement({
              sid: 'S3DataLakeAccess',
              effect: iam.Effect.ALLOW,
              actions: [
                's3:GetObject',
                's3:PutObject',
                's3:DeleteObject',
                's3:ListBucket',
                's3:GetBucketLocation',
              ],
              resources: [dataLakeBucketArn, `${dataLakeBucketArn}/*`],
            }),
            // CloudWatch Logs for workflow run logging
            new iam.PolicyStatement({
              sid: 'CloudWatchLogs',
              effect: iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams',
              ],
              resources: [
                `arn:aws:logs:${region}:${account}:log-group:/aws/omics/*`,
              ],
            }),
            // ECR — GetAuthorizationToken is registry-level (must be Resource: *)
            new iam.PolicyStatement({
              sid: 'EcrGetAuthToken',
              effect: iam.Effect.ALLOW,
              actions: ['ecr:GetAuthorizationToken'],
              resources: ['*'],
            }),
            // ECR — image pull actions scoped to the two workflow repos
            new iam.PolicyStatement({
              sid: 'EcrImagePull',
              effect: iam.Effect.ALLOW,
              actions: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
              ],
              resources: [
                // The AMR workflow uses the fastp-skesa (assembly) image and the
                // funcscan (AMRFinderPlus) image; both are passed as run params.
                `arn:aws:ecr:${region}:${account}:repository/${resourcePrefix}-amr-fastp-skesa`,
                `arn:aws:ecr:${region}:${account}:repository/${resourcePrefix}-amr-funcscan`,
              ],
            }),
            // KMS — decrypt S3 data lake objects and encrypt HealthOmics run output
            new iam.PolicyStatement({
              sid: 'KmsDecryptEncrypt',
              effect: iam.Effect.ALLOW,
              actions: [
                'kms:Decrypt',
                'kms:GenerateDataKey',
                'kms:GenerateDataKeyWithoutPlaintext',
                'kms:DescribeKey',
                'kms:ReEncryptFrom',
                'kms:ReEncryptTo',
              ],
              resources: [healthOmicsCmkArn, s3DataLakeCmkArn],
            }),
            // SSM — read ECR digest parameters at run time
            new iam.PolicyStatement({
              sid: 'SsmReadDigests',
              effect: iam.Effect.ALLOW,
              actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
              resources: [
                `arn:aws:ssm:${region}:${account}:parameter${paramNamespace}/ecr/digests/*`,
              ],
            }),
          ],
        }),
      },
    });

    // Allow HealthOmics to use the CMK for run encryption
    healthOmicsKey.grant(omicsRole, 'kms:Decrypt', 'kms:GenerateDataKey*', 'kms:DescribeKey');

    // ── Merged AMR workflow: fastp -> SKESA -> AMRFinderPlus ───────────────
    // Bundle the workflow directory as a CDK S3 asset (auto-zipped).
    const amrAsset = new s3Assets.Asset(this, 'AmrWorkflowAsset', {
      path: path.join(__dirname, '../../src/workflows/amr'),
    });

    // HealthOmics workflows are IMMUTABLE: an in-place CloudFormation update
    // does not change the workflow's definition or parameterTemplate. A new
    // workflow must be created instead. CfnWorkflow replaces the resource when
    // its name changes, so the name embeds a short hash of the workflow asset
    // (definition + config). Any change to the workflow definition therefore
    // provisions a fresh workflow, refreshes the SSM id param, and retires the
    // old one — no silent no-op updates.
    const amrDefHash = amrAsset.assetHash.substring(0, 12);
    const amrWorkflow = new omics.CfnWorkflow(this, 'AmrWorkflow', {
      name: `${resourcePrefix}-amr-genomics-${amrDefHash}`,
      engine: 'NEXTFLOW',
      definitionUri: `s3://${amrAsset.s3BucketName}/${amrAsset.s3ObjectKey}`,
      description: `${resourcePrefix} AMR genomics: fastp QC + SKESA assembly + AMRFinderPlus (Nextflow DSL2)`,
      storageCapacity: 100,
      parameterTemplate: {
        read1: {
          description: 'S3 URI for the R1 paired-end FASTQ file',
          optional: false,
        },
        read2: {
          description: 'S3 URI for the R2 paired-end FASTQ file',
          optional: false,
        },
        isolate_id: {
          description: 'Sample/isolate identifier',
          optional: false,
        },
        organism: {
          description: 'Organism name for AMRFinderPlus (default: Salmonella)',
          optional: true,
        },
        assembly_container: {
          description: 'ECR image URI for the fastp + SKESA assembly tasks',
          optional: false,
        },
        amr_container: {
          description: 'ECR image URI for the AMRFinderPlus task (database bundled)',
          optional: false,
        },
        min_length: {
          description: 'Minimum read length after trimming (default: 50)',
          optional: true,
        },
        fastp_args: {
          description: 'Additional fastp CLI arguments',
          optional: true,
        },
      },
      tags: {
        'apex:run-id': runId,
        'apex:prefix':  resourcePrefix,
        'workflow-type': 'amr-genomics',
      },
    });

    // ── Grant CDK bootstrap bucket read access to HealthOmics role ─────────
    // HealthOmics needs to fetch the workflow zip from the CDK assets bucket.
    amrAsset.bucket.grantRead(omicsRole);

    // ── SSM Parameters — workflow ARN for downstream stacks ────────────────
    new ssm.StringParameter(this, 'AmrWorkflowArnParam', {
      parameterName: `${paramNamespace}/workflows/amr-arn`,
      stringValue:   amrWorkflow.attrArn,
      description:   `${resourcePrefix} AMR genomics workflow ARN`,
      tier: ssm.ParameterTier.STANDARD,
    });

    // The numeric workflow id (CfnWorkflow.ref) is what omics:startRun expects.
    // Publish it to SSM so the pipeline state machine reads it at runtime,
    // rather than importing it as a synth-time cross-stack export. This keeps
    // the two stacks decoupled and avoids export-in-use deadlocks when the
    // workflow definition changes.
    new ssm.StringParameter(this, 'AmrWorkflowIdParam', {
      parameterName: `${paramNamespace}/workflows/amr-id`,
      stringValue:   amrWorkflow.ref,
      description:   `${resourcePrefix} AMR genomics workflow id`,
      tier: ssm.ParameterTier.STANDARD,
    });

    new ssm.StringParameter(this, 'OmicsRoleArnParam', {
      parameterName: `${paramNamespace}/omics/service-role-arn`,
      stringValue:   omicsRole.roleArn,
      description:   `${resourcePrefix} AMR HealthOmics service role ARN`,
      tier: ssm.ParameterTier.STANDARD,
    });

    // ── CloudFormation Outputs ──────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AmrWorkflowArn', {
      value:      amrWorkflow.attrArn,
      exportName: `${resourcePrefix}-amr-genomics-workflow-arn`,
      description: 'ARN of the merged AMR genomics HealthOmics workflow',
    });

    new cdk.CfnOutput(this, 'OmicsServiceRoleArn', {
      value:      omicsRole.roleArn,
      exportName: `${resourcePrefix}-amr-omics-role-arn`,
      description: 'ARN of the HealthOmics service IAM role',
    });

    // Expose for programmatic cross-stack references (consumed by PipelineStack).
    // attrArn is the full workflow ARN; ref is the physical workflow id, which is
    // what the omics:startRun WorkflowId parameter expects. Using ref avoids a
    // synth-time string .split() on a deploy-time token.
    this.omicsServiceRoleArn = omicsRole.roleArn;
    this.amrWorkflowArn = amrWorkflow.attrArn;
    this.amrWorkflowId = amrWorkflow.ref;
    this.amrWorkflowIdParamName = `${paramNamespace}/workflows/amr-id`;
  }
}
