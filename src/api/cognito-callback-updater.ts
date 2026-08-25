/**
 * Custom Resource Lambda: CognitoCallbackUpdater
 *
 * Registers the deployed CloudFront URL as an allowed OAuth callback/logout URL
 * on the Cognito user pool client. This resolves the ordering problem where the
 * CloudFront domain is only known after the frontend distribution is created,
 * while the user pool client is created earlier in the API stack.
 *
 * It performs a read-modify-write (DescribeUserPoolClient then
 * UpdateUserPoolClient) so existing client settings are preserved and the
 * callback/logout URLs are merged, not replaced.
 */
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  UpdateUserPoolClientCommand,
  type UpdateUserPoolClientCommandInput,
} from '@aws-sdk/client-cognito-identity-provider';

const client = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });

interface ResourceProps {
  UserPoolId: string;
  ClientId: string;
  CallbackUrls: string[];
  LogoutUrls: string[];
}

function uniqueMerge(existing: string[] | undefined, additions: string[]): string[] {
  return Array.from(new Set([...(existing ?? []), ...additions]));
}

async function applyCallbackUrls(props: ResourceProps): Promise<void> {
  const described = await client.send(
    new DescribeUserPoolClientCommand({
      UserPoolId: props.UserPoolId,
      ClientId: props.ClientId,
    }),
  );
  const existing = described.UserPoolClient;
  if (!existing) {
    throw new Error(`User pool client ${props.ClientId} not found`);
  }

  // Read-modify-write: carry forward every existing setting, merging only the
  // callback and logout URL lists. UpdateUserPoolClient resets any field that is
  // omitted, so all preserved fields must be passed through explicitly.
  const update: UpdateUserPoolClientCommandInput = {
    UserPoolId: props.UserPoolId,
    ClientId: props.ClientId,
    ClientName: existing.ClientName,
    RefreshTokenValidity: existing.RefreshTokenValidity,
    AccessTokenValidity: existing.AccessTokenValidity,
    IdTokenValidity: existing.IdTokenValidity,
    TokenValidityUnits: existing.TokenValidityUnits,
    ReadAttributes: existing.ReadAttributes,
    WriteAttributes: existing.WriteAttributes,
    ExplicitAuthFlows: existing.ExplicitAuthFlows,
    SupportedIdentityProviders: existing.SupportedIdentityProviders,
    CallbackURLs: uniqueMerge(existing.CallbackURLs, props.CallbackUrls),
    LogoutURLs: uniqueMerge(existing.LogoutURLs, props.LogoutUrls),
    DefaultRedirectURI: existing.DefaultRedirectURI,
    AllowedOAuthFlows: existing.AllowedOAuthFlows,
    AllowedOAuthScopes: existing.AllowedOAuthScopes,
    AllowedOAuthFlowsUserPoolClient: existing.AllowedOAuthFlowsUserPoolClient,
    PreventUserExistenceErrors: existing.PreventUserExistenceErrors,
    EnableTokenRevocation: existing.EnableTokenRevocation,
    EnablePropagateAdditionalUserContextData: existing.EnablePropagateAdditionalUserContextData,
    AuthSessionValidity: existing.AuthSessionValidity,
  };

  await client.send(new UpdateUserPoolClientCommand(update));
  console.log(
    JSON.stringify({ level: 'INFO', message: 'Callback URLs updated', clientId: props.ClientId }),
  );
}

export const handler = async (event: {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: ResourceProps & { ServiceToken?: string };
}): Promise<{ PhysicalResourceId: string }> => {
  console.log(JSON.stringify({ level: 'INFO', message: 'invoked', requestType: event.RequestType }));

  const physicalId = event.PhysicalResourceId ?? 'cognito-callback-updater';

  // On delete we leave the client as-is; the client is destroyed with the API stack.
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: physicalId };
  }

  await applyCallbackUrls(event.ResourceProperties);
  return { PhysicalResourceId: physicalId };
};
