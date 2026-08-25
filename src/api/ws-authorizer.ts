/**
 * WebSocket $connect JWT authorizer Lambda.
 * Validates Cognito JWT from query string ?token=...
 * Returns IAM policy allowing/denying execute-api:Invoke
 */
import { APIGatewayRequestAuthorizerEvent, APIGatewayAuthorizerResult } from 'aws-lambda';
import * as https from 'https';

const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;
const REGION = process.env.AWS_REGION ?? 'us-west-2';

const JWKS_URL = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;

interface JwksKey {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg: string;
  use: string;
}

let cachedKeys: JwksKey[] | null = null;
let cacheExpiry = 0;

async function fetchJwks(): Promise<JwksKey[]> {
  if (cachedKeys && Date.now() < cacheExpiry) return cachedKeys;

  return new Promise((resolve, reject) => {
    https.get(JWKS_URL, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          cachedKeys = parsed.keys;
          cacheExpiry = Date.now() + 3600 * 1000; // cache 1 hour
          resolve(cachedKeys!);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function base64UrlDecode(str: string): Buffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64');
}

function decodeJwtHeader(token: string): { kid?: string; alg?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  return JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  return JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
}

async function verifyJwt(token: string): Promise<Record<string, unknown>> {
  const header = decodeJwtHeader(token);
  const payload = decodeJwtPayload(token);

  // Basic validation
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('Token expired');
  }

  // Verify issuer
  const expectedIssuer = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
  if (payload.iss !== expectedIssuer) {
    throw new Error(`Invalid issuer: ${payload.iss}`);
  }

  // Verify audience (ID token has aud = client_id)
  const aud = payload.aud;
  if (aud !== CLIENT_ID && !(Array.isArray(aud) && aud.includes(CLIENT_ID))) {
    // Check token_use for access tokens
    if (payload.token_use !== 'access' && payload.client_id !== CLIENT_ID) {
      throw new Error('Invalid audience');
    }
  }

  // Fetch JWKS and verify signature using kid
  const keys = await fetchJwks();
  const key = keys.find((k) => k.kid === header.kid);
  if (!key) {
    throw new Error(`Key not found: ${header.kid}`);
  }

  // Use Node.js crypto to verify RS256 signature
  const crypto = await import('crypto');
  const parts = token.split('.');
  const message = `${parts[0]}.${parts[1]}`;
  const signature = base64UrlDecode(parts[2]);

  // Reconstruct public key from JWK (n, e)
  const publicKey = crypto.createPublicKey({
    key: {
      kty: 'RSA',
      n: key.n,
      e: key.e,
    },
    format: 'jwk',
  });

  const isValid = crypto.verify(
    'SHA256',
    Buffer.from(message),
    { key: publicKey, dsaEncoding: 'ieee-p1363', padding: crypto.constants.RSA_PKCS1_PADDING },
    signature,
  );

  if (!isValid) {
    throw new Error('Invalid signature');
  }

  return payload;
}

function buildPolicy(
  principalId: string,
  effect: 'Allow' | 'Deny',
  resource: string,
  context?: Record<string, string>,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: context ?? {},
  };
}

export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  console.log(JSON.stringify({ level: 'INFO', message: 'ws-authorizer invoked', methodArn: event.methodArn }));

  // Extract token from query string parameter
  const token =
    event.queryStringParameters?.token ??
    event.queryStringParameters?.Token;

  if (!token) {
    console.log(JSON.stringify({ level: 'WARN', message: 'No token in query string' }));
    return buildPolicy('unauthenticated', 'Deny', event.methodArn);
  }

  try {
    const payload = await verifyJwt(token);
    const sub = (payload.sub as string) ?? (payload['cognito:username'] as string) ?? 'unknown';
    const email = (payload.email as string) ?? sub;

    console.log(JSON.stringify({ level: 'INFO', message: 'Token verified', sub, email }));

    return buildPolicy(sub, 'Allow', event.methodArn, {
      sub,
      email,
      userId: sub,
    });
  } catch (err) {
    console.log(JSON.stringify({ level: 'WARN', message: 'Token verification failed', error: String(err) }));
    return buildPolicy('unauthenticated', 'Deny', event.methodArn);
  }
};
