/**
 * POST /ingestion/trigger
 * Validates and triggers ingestion via ingestion-validator Lambda + Step Functions
 * (STANDARD workflow). The SFN execution name is set to the run_id so that
 * DynamoDB records and the Workflows UI stay correlated.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import {
  LambdaClient,
  InvokeCommand,
} from '@aws-sdk/client-lambda';

const sfnClient = new SFNClient({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const INGESTION_VALIDATOR_ARN = process.env.INGESTION_VALIDATOR_ARN!;

/** Structured JSON logger with mandatory fields: run_id, user_id, stage */
function log(level: string, message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, message, stage: 'ingestion-trigger', ...extra }));
}

function corsHeaders() {
  const origin = process.env.CLOUDFRONT_URL
    ? `https://${process.env.CLOUDFRONT_URL}`
    : '*';
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  // Extract user_id from Cognito JWT claims (NFR-015)
  const userId = (event.requestContext as { authorizer?: { claims?: { sub?: string } } })
    ?.authorizer?.claims?.sub ?? 'anonymous';
  const runId = `api-${Date.now()}`;
  log('INFO', 'ingestion-trigger invoked', { path: event.path, run_id: runId, user_id: userId });

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // Accept either {accessionId: 'X'} (single) or {accessions: ['X', 'Y']} (array from UI).
  let accessionsRaw: string[] = [];
  if (Array.isArray(body.accessions)) {
    accessionsRaw = (body.accessions as unknown[]).map((a) => String(a).trim()).filter(Boolean);
  } else if (body.accessionId) {
    accessionsRaw = [String(body.accessionId).trim()];
  }

  if (accessionsRaw.length === 0) {
    log('WARN', 'Missing accessionId/accessions', { run_id: runId, user_id: userId });
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'accessionId (string) or accessions (array) is required' }),
    };
  }

  // For backward-compat we keep accessionId = first accession in the request body.
  const accessionId = accessionsRaw[0];

  // Controlled-access check: reject dbGaP accessions (FR-020/NFR-014)
  if (/^phs\d+/i.test(accessionId) || /controlled|dbgap/i.test(accessionId)) {
    log('WARN', 'REJECTED: controlled-access accession', { run_id: runId, user_id: userId, accessionId });
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Controlled-access source rejected',
        reason: 'Only public NCBI SRA data is permitted. dbGaP/controlled-access accessions are not supported.',
        accessionId,
      }),
    };
  }

  // Invoke ingestion-validator Lambda first
  try {
    const validatorResp = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: INGESTION_VALIDATOR_ARN,
        Payload: Buffer.from(JSON.stringify({
          accession: accessionId,
          source: 'ncbi-sra-public',
          isolate_id: `isolate-${accessionId}`,
          run_id: runId,
        })),
      }),
    );

    if (validatorResp.FunctionError) {
      const errPayload = validatorResp.Payload
        ? JSON.parse(Buffer.from(validatorResp.Payload).toString())
        : {};
      log('WARN', 'Validator rejected accession', { run_id: runId, user_id: userId, accessionId, error: errPayload });
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Validation failed', reason: errPayload?.errorMessage ?? validatorResp.FunctionError, accessionId }),
      };
    }

    // Parse validator output to get source_provenance for 200 response
    let validatorOutput: Record<string, unknown> = {};
    if (validatorResp.Payload) {
      try {
        validatorOutput = JSON.parse(Buffer.from(validatorResp.Payload).toString());
      } catch {
        // non-fatal
      }
    }
    log('INFO', 'Validation passed', { run_id: runId, user_id: userId, accessionId, source_provenance: validatorOutput.source_provenance });

    // Store for SFN payload
    (body as Record<string, unknown>).source_provenance = validatorOutput.source_provenance ?? 'ncbi-sra-public';
    (body as Record<string, unknown>).license = validatorOutput.license ?? 'us-gov-public-domain';
  } catch (err) {
    log('ERROR', 'Validator invocation failed', { run_id: runId, user_id: userId, error: String(err) });
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Validator invocation failed' }),
    };
  }

  // Start Step Functions execution.
  // Map state's ItemsPath=$.isolates requires {isolates: [{...}, ...]} input shape.
  const sourceProvenance = (body as Record<string, unknown>).source_provenance ?? 'ncbi-sra-public';
  const license = (body as Record<string, unknown>).license ?? 'us-gov-public-domain';
  const isolatesInput = accessionsRaw.map((acc) => ({
    isolate_id: `isolate-${acc}`,
    accession: acc,
    source: 'ncbi-sra-public',
    source_provenance: sourceProvenance,
    license,
    run_id: runId,
  }));

  // The SFN execution name IS the run_id. Every Lambda in the pipeline writes
  // DynamoDB records keyed on this run_id, and the UI (workflows-list /
  // workflow-detail) correlates executions to those records by execution name.
  // Using a different name here would leave the run_id-index GSI query with no
  // matches, so the Workflows page could never resolve isolates or stages.
  const executionName = runId;
  try {
    const sfnResp = await sfnClient.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: executionName,
        input: JSON.stringify({
          isolates: isolatesInput,
          accessionId,
          triggeredBy: 'api',
          run_id: runId,
          user_id: userId,
        }),
      }),
    );

    const executionId = sfnResp.executionArn?.split(':').pop() ?? executionName;
    log('INFO', 'Execution started', { run_id: runId, user_id: userId, executionArn: sfnResp.executionArn });

    return {
      statusCode: 202,
      headers: corsHeaders(),
      body: JSON.stringify({
        executionId,
        executionArn: sfnResp.executionArn,
        status: 'STARTED',
        accessionId,
        accessions: accessionsRaw,
        source_provenance: (body as Record<string, unknown>).source_provenance,
        license: (body as Record<string, unknown>).license,
      }),
    };
  } catch (err) {
    log('ERROR', 'SFN start failed', { run_id: runId, user_id: userId, error: String(err) });
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Failed to start pipeline execution' }),
    };
  }
};
