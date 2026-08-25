/**
 * GET /workflows
 * Lists Step Functions executions + DynamoDB run records.
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  SFNClient,
  ListExecutionsCommand,
} from '@aws-sdk/client-sfn';
import {
  DynamoDBClient,
  ScanCommand,
} from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

const sfnClient = new SFNClient({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const DYNAMO_TABLE = process.env.DYNAMO_TABLE_NAME!;

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
  _event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  console.log(JSON.stringify({ level: 'INFO', message: 'workflows-list invoked' }));

  try {
    const [sfnResp, dynamoResp] = await Promise.all([
      sfnClient.send(
        new ListExecutionsCommand({
          stateMachineArn: STATE_MACHINE_ARN,
          maxResults: 50,
        }),
      ),
      dynamoClient.send(
        new ScanCommand({
          TableName: DYNAMO_TABLE,
          Limit: 50,
        }),
      ),
    ]);

    // Count distinct isolates seen per run from the DynamoDB state table so the
    // UI can show an isolate count next to each execution.
    const dbRecords = (dynamoResp.Items ?? []).map((item) => unmarshall(item));
    const isolatesByRun = new Map<string, Set<string>>();
    for (const rec of dbRecords) {
      const runId = typeof rec.run_id === 'string' ? rec.run_id : undefined;
      const isolateId = typeof rec.isolate_id === 'string' ? rec.isolate_id : undefined;
      if (!runId) continue;
      if (!isolatesByRun.has(runId)) isolatesByRun.set(runId, new Set());
      if (isolateId) isolatesByRun.get(runId)!.add(isolateId);
    }

    // Return the shape the frontend consumes: executionId / startTime / endTime /
    // status / isolateCount. The SFN execution name is the run id.
    const executions = (sfnResp.executions ?? []).map((e) => {
      const name = e.name ?? '';
      const isolateCount = isolatesByRun.get(name)?.size;
      return {
        executionId: name,
        executionArn: e.executionArn,
        status: e.status,
        startTime: e.startDate?.toISOString(),
        endTime: e.stopDate?.toISOString(),
        isolateCount: isolateCount ?? undefined,
      };
    });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ executions }),
    };
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', message: 'workflows-list failed', error: String(err) }));
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Failed to list workflows' }),
    };
  }
};
