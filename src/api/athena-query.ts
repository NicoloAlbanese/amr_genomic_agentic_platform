/**
 * POST /athena/query
 * Proxy for Athena StartQueryExecution + GetQueryResults.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });

const ATHENA_DATABASE = process.env.ATHENA_DATABASE!;
const ATHENA_CATALOG = process.env.ATHENA_CATALOG ?? 'AwsDataCatalog';
const ATHENA_WORKGROUP = process.env.ATHENA_WORKGROUP!;
const ATHENA_RESULTS_BUCKET = process.env.ATHENA_RESULTS_BUCKET!;

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

async function waitForQuery(queryExecutionId: string, maxWaitMs = 25000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const resp = await athenaClient.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
    );
    const state = resp.QueryExecution?.Status?.State;
    if (state === QueryExecutionState.SUCCEEDED) return 'SUCCEEDED';
    if (state === QueryExecutionState.FAILED || state === QueryExecutionState.CANCELLED) {
      throw new Error(`Query ${state}: ${resp.QueryExecution?.Status?.StateChangeReason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 'RUNNING'; // Return async if still running
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log(JSON.stringify({ level: 'INFO', message: 'athena-query invoked' }));

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!body.query) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'query is required' }) };
  }

  try {
    // ResultConfiguration omitted: workgroup enforces EnforceWorkGroupConfiguration=true
    // with SSE_KMS output; providing a conflicting ResultConfiguration causes
    // "Unable to verify/create output bucket" errors.
    const startResp = await athenaClient.send(
      new StartQueryExecutionCommand({
        QueryString: body.query as string,
        QueryExecutionContext: {
          Database: ATHENA_DATABASE,
          Catalog: ATHENA_CATALOG,
        },
        WorkGroup: ATHENA_WORKGROUP,
      }),
    );

    const queryExecutionId = startResp.QueryExecutionId!;
    const finalState = await waitForQuery(queryExecutionId);

    if (finalState === 'RUNNING') {
      return {
        statusCode: 202,
        headers: corsHeaders(),
        body: JSON.stringify({ queryExecutionId, status: 'RUNNING', message: 'Query still running, poll with queryExecutionId' }),
      };
    }

    const resultsResp = await athenaClient.send(
      new GetQueryResultsCommand({
        QueryExecutionId: queryExecutionId,
        MaxResults: 100,
      }),
    );

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        queryExecutionId,
        status: 'SUCCEEDED',
        resultSet: resultsResp.ResultSet,
      }),
    };
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', message: 'athena-query failed', error: String(err) }));
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: String(err) }),
    };
  }
};
