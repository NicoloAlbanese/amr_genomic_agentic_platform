/**
 * Custom Resource Lambda: SmokeUsersSeeder
 * Creates the demo admin user with a permanent password stored in Secrets
 * Manager. The username is passed via an environment variable — no PII and no
 * password is hardcoded here, and the generated password never leaves Secrets
 * Manager.
 */
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  CreateSecretCommand,
  DescribeSecretCommand,
} from '@aws-sdk/client-secrets-manager';

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

const USER_POOL_ID = process.env.USER_POOL_ID!;
const RESOURCE_PREFIX = process.env.RESOURCE_PREFIX!;
// Username comes from an environment variable set in CDK — not hardcoded
const ADMIN_USERNAME = process.env.ADMIN_USERNAME!;

function generatePassword(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$';
  const rand = (s: string) => s[Math.floor(Math.random() * s.length)];
  const base = Array.from({ length: 8 }, () => rand(chars)).join('');
  return base + rand(uppers) + rand(uppers) + rand(digits) + rand(digits) + rand(symbols) + rand(symbols);
}

async function ensureSecret(secretName: string): Promise<string> {
  try {
    const desc = await secretsClient.send(new DescribeSecretCommand({ SecretId: secretName }));
    if (desc.Name) {
      const val = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));
      return val.SecretString!;
    }
  } catch {
    // secret does not exist yet — create it below
  }

  const password = generatePassword();
  await secretsClient.send(
    new CreateSecretCommand({
      Name: secretName,
      SecretString: password,
      Tags: [
        { Key: 'apex:prefix', Value: RESOURCE_PREFIX },
        { Key: 'apex:purpose', Value: 'smoke-test-credential' },
      ],
    }),
  );
  return password;
}

async function provisionUser(username: string, password: string): Promise<void> {
  try {
    await cognitoClient.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }),
    );
    // User already exists — refresh permanent password
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        Password: password,
        Permanent: true,
      }),
    );
    console.log(JSON.stringify({ level: 'INFO', message: 'Updated existing user', username }));
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'UserNotFoundException') {
      await cognitoClient.send(
        new AdminCreateUserCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          TemporaryPassword: password,
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: username },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      );
      // Immediately set permanent so users start CONFIRMED, not FORCE_CHANGE_PASSWORD
      await cognitoClient.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: USER_POOL_ID,
          Username: username,
          Password: password,
          Permanent: true,
        }),
      );
      console.log(JSON.stringify({ level: 'INFO', message: 'Created user with permanent password', username }));
    } else {
      throw err;
    }
  }
}

export const handler = async (event: {
  RequestType: string;
  PhysicalResourceId?: string;
}): Promise<{ PhysicalResourceId: string; Data: Record<string, string> }> => {
  console.log(JSON.stringify({ level: 'INFO', message: 'smoke-users-seeder invoked', requestType: event.RequestType }));

  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId ?? 'smoke-users', Data: {} };
  }

  const adminSecretName = `${RESOURCE_PREFIX}/amr/cognito/admin-password`;

  const adminPassword = await ensureSecret(adminSecretName);

  await provisionUser(ADMIN_USERNAME, adminPassword);

  console.log(JSON.stringify({ level: 'INFO', message: 'Demo user provisioned successfully' }));

  return {
    PhysicalResourceId: 'smoke-users',
    Data: {
      adminUser: ADMIN_USERNAME,
      adminSecretName,
    },
  };
};
