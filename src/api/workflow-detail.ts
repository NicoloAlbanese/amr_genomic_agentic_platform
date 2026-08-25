/**
 * GET /workflows/{runId}
 * Returns run detail with a per-stage status timeline.
 *
 * The authoritative source of stage progress is the Step Functions execution
 * history: every isolate flows through the same set of states, and the history
 * records exactly which states were entered, when, and whether the execution
 * failed. Deriving stages from the history means the timeline is correct for
 * every run regardless of what the per-isolate DynamoDB events happened to log
 * (those only cover the first two stages) and regardless of whether the run_id
 * matches the execution name (scheduled runs use a UUID execution name).
 */
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
  SFNClient,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  HistoryEvent,
} from '@aws-sdk/client-sfn';

const sfnClient = new SFNClient({ region: process.env.AWS_REGION });

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

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

type StageStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

interface Stage {
  stage: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Ordered logical stages of the pipeline. Several Step Functions states map to
 * one user-facing stage (the genomics run is a poll loop of StartAmrRun +
 * GetAmrRunStatus; ETL is a single Glue job). Order drives the timeline layout.
 */
const STAGE_DEFINITIONS: { label: string; states: string[] }[] = [
  { label: 'Validation', states: ['ValidateIngestion'] },
  { label: 'Deduplication', states: ['DeduplicateIsolate'] },
  { label: 'SRA Fetch', states: ['RunSraFetcher'] },
  { label: 'Assembly and AMR Scan', states: ['StartAmrRun', 'GetAmrRunStatus'] },
  { label: 'Harmonization', states: ['RunHamronization'] },
  { label: 'ETL to Iceberg', states: ['RunGlueEtl'] },
  { label: 'Concordance', states: ['ComputeConcordance'] },
];

const STATE_TO_STAGE = new Map<string, string>();
for (const def of STAGE_DEFINITIONS) {
  for (const s of def.states) STATE_TO_STAGE.set(s, def.label);
}

async function getFullHistory(executionArn: string): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await sfnClient.send(
      new GetExecutionHistoryCommand({
        executionArn,
        maxResults: 1000,
        includeExecutionData: false,
        nextToken,
      }),
    );
    events.push(...(resp.events ?? []));
    nextToken = resp.nextToken;
  } while (nextToken);
  return events;
}

/**
 * Reduce the execution history into one status entry per logical stage.
 * A stage is SUCCEEDED once any of its states exits, RUNNING while a state is
 * entered but not exited, and FAILED if the execution failed while that stage
 * was the most recently entered one.
 */
function deriveStages(events: HistoryEvent[], executionStatus: string): Stage[] {
  const started = new Map<string, string>();
  const completed = new Map<string, string>();
  let lastEnteredStage: string | undefined;

  for (const ev of events) {
    const ts = ev.timestamp ? new Date(ev.timestamp).toISOString() : undefined;
    const enteredName = ev.stateEnteredEventDetails?.name;
    const exitedName = ev.stateExitedEventDetails?.name;

    if (enteredName && STATE_TO_STAGE.has(enteredName)) {
      const stage = STATE_TO_STAGE.get(enteredName)!;
      if (!started.has(stage) && ts) started.set(stage, ts);
      lastEnteredStage = stage;
    }
    if (exitedName && STATE_TO_STAGE.has(exitedName)) {
      const stage = STATE_TO_STAGE.get(exitedName)!;
      if (ts) completed.set(stage, ts);
    }
  }

  const failed = executionStatus === 'FAILED' || executionStatus === 'TIMED_OUT' || executionStatus === 'ABORTED';

  return STAGE_DEFINITIONS.map(({ label }) => {
    const startedAt = started.get(label);
    const completedAt = completed.get(label);
    let status: StageStatus;
    if (completedAt) {
      status = 'SUCCEEDED';
    } else if (startedAt) {
      status = failed && label === lastEnteredStage ? 'FAILED' : 'RUNNING';
    } else {
      status = 'PENDING';
    }
    return { stage: label, status, startedAt, completedAt };
  });
}

function countIsolatesFromInput(input?: string): number | undefined {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input) as { isolates?: unknown[] };
    return Array.isArray(parsed.isolates) ? parsed.isolates.length : undefined;
  } catch {
    return undefined;
  }
}

export const handler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const runId = event.pathParameters?.runId
    ? decodeURIComponent(event.pathParameters.runId)
    : undefined;
  if (!runId) {
    return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'runId is required' }) };
  }

  console.log(JSON.stringify({ level: 'INFO', message: 'workflow-detail invoked', runId }));

  const region = process.env.AWS_REGION ?? 'us-west-2';
  const account = STATE_MACHINE_ARN.split(':')[4];
  const smName = STATE_MACHINE_ARN.split(':').pop()!;
  const executionArn = `arn:aws:states:${region}:${account}:execution:${smName}:${runId}`;

  try {
    const describe = await sfnClient.send(
      new DescribeExecutionCommand({ executionArn }),
    );
    const status = describe.status ?? 'UNKNOWN';

    const history = await getFullHistory(executionArn);
    const stages = deriveStages(history, status);
    const isolateCount = countIsolatesFromInput(describe.input);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        executionId: runId,
        status,
        startTime: describe.startDate?.toISOString(),
        endTime: describe.stopDate?.toISOString(),
        isolateCount,
        stages,
      }),
    };
  } catch (err) {
    // A missing execution (runId is not an SFN execution name) is a 404, not a
    // server error, so the UI can show a clear "not found" instead of retrying.
    const name = err instanceof Error ? err.name : '';
    if (name === 'ExecutionDoesNotExist') {
      return {
        statusCode: 404,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Execution not found', executionId: runId }),
      };
    }
    console.error(JSON.stringify({ level: 'ERROR', message: 'workflow-detail failed', error: String(err) }));
    return {
      statusCode: 502,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Failed to get workflow detail', detail: String(err) }),
    };
  }
};
