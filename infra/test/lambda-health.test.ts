/**
 * Unit tests for health Lambda handler
 */
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { handler } from '../../src/api/health';

const mockEvent: APIGatewayProxyEvent = {
  httpMethod: 'GET',
  path: '/health',
  body: null,
  headers: {},
  multiValueHeaders: {},
  queryStringParameters: null,
  multiValueQueryStringParameters: null,
  pathParameters: null,
  stageVariables: null,
  isBase64Encoded: false,
  resource: '/health',
  requestContext: {} as APIGatewayProxyEvent['requestContext'],
};

describe('health Lambda handler', () => {
  test('returns 200 status', async () => {
    const result = await handler(mockEvent);
    expect(result.statusCode).toBe(200);
  });

  test('returns JSON body with status=ok', async () => {
    const result = await handler(mockEvent);
    const body = JSON.parse(result.body);
    expect(body.status).toBe('ok');
    expect(body.service).toBe('amr-api');
  });

  test('returns Content-Type header', async () => {
    const result = await handler(mockEvent);
    expect(result.headers?.['Content-Type']).toBe('application/json');
  });

  test('includes timestamp in response', async () => {
    const result = await handler(mockEvent);
    const body = JSON.parse(result.body);
    expect(body.timestamp).toBeDefined();
    // Verify timestamp is a valid ISO date
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});
