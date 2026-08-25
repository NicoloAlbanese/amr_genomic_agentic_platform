/**
 * Unit tests for ingestion-trigger Lambda handler (TypeScript)
 * Tests happy path + failure paths for FR-020/NFR-014
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock AWS SDK clients before importing handler
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  StartExecutionCommand: jest.fn().mockImplementation((params) => ({ ...params, _type: 'StartExecution' })),
}));
jest.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  InvokeCommand: jest.fn().mockImplementation((params) => ({ ...params, _type: 'Invoke' })),
}));

// Set required environment variables using placeholder values safe for test
const TEST_ACCOUNT = process.env.TEST_ACCOUNT_ID ?? '000000000000';
const TEST_REGION = process.env.TEST_REGION ?? 'us-east-1';

process.env.STATE_MACHINE_ARN = `arn:aws:states:${TEST_REGION}:${TEST_ACCOUNT}:stateMachine:test-amr-pipeline`;
process.env.INGESTION_VALIDATOR_ARN = `arn:aws:lambda:${TEST_REGION}:${TEST_ACCOUNT}:function:test-amr-ingestion-validator`;
process.env.AWS_REGION = TEST_REGION;

// Helper to build a mock API Gateway event
function buildEvent(body: Record<string, unknown>, claims?: { sub?: string }): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/ingestion/trigger',
    body: JSON.stringify(body),
    headers: {},
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    isBase64Encoded: false,
    resource: '/ingestion/trigger',
    requestContext: {
      authorizer: claims ? { claims } : undefined,
    } as APIGatewayProxyEvent['requestContext'],
  };
}

describe('ingestion-trigger Lambda handler', () => {
  let handler: (event: APIGatewayProxyEvent) => Promise<{ statusCode: number; body: string }>;

  beforeAll(() => {
    // Dynamic import after mocks are set up
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    handler = require('../../src/api/ingestion-trigger').handler;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---- Controlled-access rejection tests (FR-020) ----

  test('rejects dbGaP phs accessions with 400', async () => {
    const event = buildEvent({ accessionId: 'phs000123' }, { sub: 'user-123' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/controlled-access/i);
  });

  test('rejects accessions with _controlled suffix with 400', async () => {
    const event = buildEvent({ accessionId: 'SRR999999_controlled' }, { sub: 'user-123' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toMatch(/controlled-access/i);
  });

  // ---- Input validation tests ----

  test('returns 400 for missing accessionId', async () => {
    const event = buildEvent({});
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('accessionId (string) or accessions (array) is required');
  });

  test('returns 400 for invalid JSON body', async () => {
    const event = buildEvent({});
    event.body = 'not-json';
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toContain('Invalid JSON');
  });

  // ---- Happy path tests ----

  test('returns 202 for valid public SRA accession', async () => {
    // Mock validator invoke returning success
    mockSend.mockResolvedValueOnce({
      StatusCode: 200,
      FunctionError: undefined,
      Payload: Buffer.from(JSON.stringify({
        validated: true,
        source_provenance: 'NCBI SRA Public',
        license: 'US Government public domain (NCBI SRA)',
      })),
    });
    // Mock SFN start execution
    mockSend.mockResolvedValueOnce({
      executionArn: `arn:aws:states:${TEST_REGION}:${TEST_ACCOUNT}:execution:test-pipeline:api-123`,
    });

    const event = buildEvent({ accessionId: 'SRR000001' }, { sub: 'user-abc' });
    const result = await handler(event);
    expect(result.statusCode).toBe(202);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('STARTED');
    expect(body.source_provenance).toBe('NCBI SRA Public');
  });

  test('returns 400 when validator Lambda rejects with FunctionError', async () => {
    mockSend.mockResolvedValueOnce({
      StatusCode: 200,
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({
        errorMessage: 'Controlled-access source rejected',
        errorType: 'ValueError',
      })),
    });

    const event = buildEvent({ accessionId: 'SRR999888' }, { sub: 'user-xyz' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.error).toContain('Validation failed');
  });

  test('returns 502 when validator Lambda throws', async () => {
    mockSend.mockRejectedValueOnce(new Error('Lambda invocation failed'));

    const event = buildEvent({ accessionId: 'SRR123456' }, { sub: 'user-xyz' });
    const result = await handler(event);
    expect(result.statusCode).toBe(502);
  });

  test('returns 502 when SFN start fails', async () => {
    // Mock validator success
    mockSend.mockResolvedValueOnce({
      StatusCode: 200,
      FunctionError: undefined,
      Payload: Buffer.from(JSON.stringify({ validated: true, source_provenance: 'NCBI SRA Public', license: 'us-gov-public-domain' })),
    });
    // Mock SFN failure
    mockSend.mockRejectedValueOnce(new Error('SFN error'));

    const event = buildEvent({ accessionId: 'SRR000002' }, { sub: 'user-abc' });
    const result = await handler(event);
    expect(result.statusCode).toBe(502);
  });

  // ---- Structured logging verification ----

  test('response includes accessionId in body', async () => {
    mockSend.mockResolvedValueOnce({
      StatusCode: 200,
      FunctionError: undefined,
      Payload: Buffer.from(JSON.stringify({ validated: true, source_provenance: 'NCBI SRA Public', license: 'us-gov' })),
    });
    mockSend.mockResolvedValueOnce({
      executionArn: `arn:aws:states:${TEST_REGION}:${TEST_ACCOUNT}:execution:test-pipeline:api-456`,
    });

    const event = buildEvent({ accessionId: 'SRR000003' }, { sub: 'user-id-xyz' });
    const result = await handler(event);
    expect(result.statusCode).toBe(202);
    const body = JSON.parse(result.body);
    expect(body.accessionId).toBe('SRR000003');
  });
});
