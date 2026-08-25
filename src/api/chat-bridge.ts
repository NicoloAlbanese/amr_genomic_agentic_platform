/**
 * WebSocket chat-bridge Lambda.
 * Routes $connect/$disconnect/chat to DynamoDB (session store) + Bedrock AgentCore Runtime.
 * Emits EMF latency metrics (ttft_ms, total_ms) to CloudWatch for NFR-003 verification.
 */
import { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResult } from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { randomUUID } from 'crypto';

const ddb = new DynamoDBClient({ region: process.env.AWS_REGION });
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const AGENT_RUNTIME_ENDPOINT_ARN = process.env.AGENT_RUNTIME_ENDPOINT_ARN ?? '';
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN ?? '';
const AWS_REGION = process.env.AWS_REGION ?? 'us-west-2';

/**
 * The InvokeAgentRuntime API takes the *runtime* ARN (no /runtime-endpoint
 * suffix) plus an optional `qualifier` for the endpoint name.  If
 * AGENT_RUNTIME_ENDPOINT_ARN points at a /runtime-endpoint/<name> URI we
 * split it into (runtimeArn, qualifier).  Otherwise we fall back to
 * AGENT_RUNTIME_ARN with qualifier DEFAULT.
 */
function resolveRuntimeAndQualifier(): { runtimeArn: string; qualifier: string } {
  if (AGENT_RUNTIME_ENDPOINT_ARN.includes('/runtime-endpoint/')) {
    const [runtimeArn, qualifier] = AGENT_RUNTIME_ENDPOINT_ARN.split('/runtime-endpoint/');
    return { runtimeArn, qualifier: qualifier || 'DEFAULT' };
  }
  if (AGENT_RUNTIME_ENDPOINT_ARN) {
    return { runtimeArn: AGENT_RUNTIME_ENDPOINT_ARN, qualifier: 'DEFAULT' };
  }
  return { runtimeArn: AGENT_RUNTIME_ARN, qualifier: 'DEFAULT' };
}

const agentCoreClient = new BedrockAgentCoreClient({ region: AWS_REGION });

function getMgmtClient(domainName: string, stage: string): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
    region: AWS_REGION,
  });
}

/** EMF structured log line — CloudWatch picks up as custom metric */
function emitEMF(metrics: Record<string, number>, userId: string, runId: string): void {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'AMR/AgentLatency',
          Dimensions: [['service']],
          Metrics: Object.keys(metrics).map((n) => ({ Name: n, Unit: 'Milliseconds' })),
        },
      ],
    },
    service: 'amr-chat-bridge',
    user_id: userId,
    run_id: runId,
    ...metrics,
  };
  console.log(JSON.stringify(emf));
}

async function safeSend(
  mgmt: ApiGatewayManagementApiClient,
  connectionId: string,
  payload: unknown,
): Promise<void> {
  try {
    await mgmt.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      }),
    );
  } catch (err) {
    if (!(err instanceof GoneException)) {
      console.warn(JSON.stringify({ level: 'WARN', event: 'post_failed', error: String(err) }));
    }
  }
}

/**
 * Collect the InvokeAgentRuntime response body into a UTF-8 string. The body can
 * be an async-iterable byte stream, a web ReadableStream, a Uint8Array, or a
 * string depending on the SDK/runtime; handle each without touching the outer
 * (non-serialisable) SDK response object.
 */
async function collectResponseBody(body: unknown): Promise<string> {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf-8');

  // Node async-iterable stream (SdkStream)
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  // SdkStream helper (transformToString) when present
  const maybeTransform = body as { transformToString?: () => Promise<string> };
  if (typeof maybeTransform.transformToString === 'function') {
    return maybeTransform.transformToString();
  }

  // Web ReadableStream with a getReader()
  const maybeReadable = body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> };
  if (typeof maybeReadable.getReader === 'function') {
    const reader = maybeReadable.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  return '';
}

/**
 * Extract the human-readable answer from the agent's response envelope. The
 * runtime returns { type: 'text', output: '<answer>' }; fall back to any
 * message/output field, or the raw text if it is not JSON.
 */
function extractAgentOutput(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) return 'The agent returned an empty response.';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const output =
      (typeof parsed.output === 'string' && parsed.output) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed.completion === 'string' && parsed.completion) ||
      (typeof parsed.error === 'string' && `Error: ${parsed.error}`);
    return output || trimmed;
  } catch {
    // Not JSON — return as-is (the runtime may emit plain text).
    return trimmed;
  }
}

async function invokeAgent(
  mgmt: ApiGatewayManagementApiClient,
  connectionId: string,
  prompt: string,
  sessionId: string,
  userId: string,
  runId: string,
): Promise<void> {
  const t0 = Date.now();
  let ttftMs = 0;

  // AgentCore agent expects {sessionId, payload:{input:{prompt}}} envelope.
  const invokePayload = JSON.stringify({ sessionId, payload: { input: { prompt } } });

  const { runtimeArn, qualifier } = resolveRuntimeAndQualifier();
  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    qualifier,
    contentType: 'application/json',
    accept: 'application/json',
    runtimeSessionId: sessionId,
    payload: Buffer.from(invokePayload),
  });

  let fullText = '';

  try {
    const resp = await agentCoreClient.send(cmd);

    // The InvokeAgentRuntime response body is a byte stream exposed on the
    // `response` member of the SDK output (older/alternate shapes used `body`).
    // Collect it fully, decode to UTF-8, and parse the agent's JSON envelope
    // ({ type: 'text', output: '...' }). We must NOT JSON.stringify the raw SDK
    // response object — it contains a non-serialisable TLSSocket (circular).
    const responseStream =
      (resp as { response?: unknown }).response ?? (resp as { body?: unknown }).body;
    const rawText = await collectResponseBody(responseStream);
    ttftMs = Date.now() - t0;
    fullText = extractAgentOutput(rawText);

    // Deliver the answer as a single token frame followed by a done frame.
    // (The agent returns one complete response, not a token stream.)
    await safeSend(mgmt, connectionId, { type: 'token', content: fullText, sessionId });
  } catch (invokeErr) {
    const totalMs = Date.now() - t0;
    console.error(JSON.stringify({
      level: 'ERROR', event: 'agentcore_invoke_failed',
      error: String(invokeErr), user_id: userId, run_id: runId, total_ms: totalMs,
    }));
    await safeSend(mgmt, connectionId, { type: 'error', content: 'Agent invocation failed', sessionId });
    throw invokeErr;
  }

  const totalMs = Date.now() - t0;
  if (ttftMs === 0) ttftMs = totalMs; // guard if no streaming happened

  await safeSend(mgmt, connectionId, { type: 'done', sessionId, ttft_ms: ttftMs, total_ms: totalMs });
  emitEMF({ ttft_ms: ttftMs, total_ms: totalMs }, userId, runId);

  console.log(JSON.stringify({
    level: 'INFO', event: 'chat_complete',
    user_id: userId, run_id: runId, session_id: sessionId,
    ttft_ms: ttftMs, total_ms: totalMs, response_length: fullText.length,
  }));
}

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResult> => {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;
  const runId = randomUUID();
  const authCtx = (event.requestContext as Record<string, unknown>).authorizer as Record<string, unknown> | undefined;
  const userId = String(authCtx?.userId ?? authCtx?.sub ?? connectionId);

  console.log(JSON.stringify({ level: 'INFO', event: 'invoked', routeKey, connectionId, user_id: userId, run_id: runId }));

  // $connect
  if (routeKey === '$connect') {
    try {
      await ddb.send(new PutItemCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          connectionId: { S: connectionId },
          userId: { S: userId },
          connectedAt: { S: new Date().toISOString() },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 7200) },
        },
      }));
    } catch (err) {
      console.error(JSON.stringify({ level: 'ERROR', event: 'connect_ddb_failed', error: String(err) }));
      return { statusCode: 500, body: 'Failed to store connection' };
    }
    return { statusCode: 200, body: 'Connected' };
  }

  // $disconnect
  if (routeKey === '$disconnect') {
    await ddb.send(new DeleteItemCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connectionId: { S: connectionId } },
    })).catch((e) => console.warn('Delete connection failed', e));
    return { statusCode: 200, body: 'Disconnected' };
  }

  // chat / $default
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    body = { message: event.body ?? '' };
  }

  const prompt = String(body.message ?? body.prompt ?? body.content ?? '');
  const rawSessionId = String(body.sessionId ?? '');
  // AgentCore session ID must be > 33 chars (runbook Pattern 8)
  const sessionId = rawSessionId.length >= 33 ? rawSessionId : `${connectionId}-${runId}`.padEnd(34, '0');

  const mgmt = getMgmtClient(domainName, stage);

  if (!prompt.trim()) {
    await safeSend(mgmt, connectionId, { type: 'error', content: 'Empty message', sessionId });
    return { statusCode: 200, body: 'OK' };
  }

  try {
    await invokeAgent(mgmt, connectionId, prompt, sessionId, userId, runId);
  } catch (err) {
    if (err instanceof GoneException) {
      console.log(JSON.stringify({ level: 'INFO', event: 'connection_gone', connectionId }));
      await ddb.send(new DeleteItemCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId: { S: connectionId } },
      })).catch(() => {});
    } else {
      console.error(JSON.stringify({ level: 'ERROR', event: 'chat_failed', error: String(err), user_id: userId, run_id: runId }));
      await safeSend(mgmt, connectionId, {
        type: 'error',
        content: 'Chat processing failed. Please try again.',
        sessionId,
      });
    }
  }

  return { statusCode: 200, body: 'OK' };
};
