import { z } from 'zod';

export const MCP_OAUTH_SCOPE = 'mcp:read';
export const oauthClientAuthMethodSchema = z.enum([
  'none',
  'client_secret_basic',
  'client_secret_post',
]);
export type OAuthClientAuthMethod = z.infer<typeof oauthClientAuthMethodSchema>;

export function isOAuthRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export const oauthRegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(128).default('Connected application'),
  redirect_uris: z.array(z.string().max(2048).refine(isOAuthRedirectUri)).min(1).max(8),
  token_endpoint_auth_method: oauthClientAuthMethodSchema.default('client_secret_basic'),
  grant_types: z
    .array(z.enum(['authorization_code', 'refresh_token']))
    .min(1)
    .optional(),
  response_types: z.array(z.literal('code')).length(1).optional(),
  scope: z.literal(MCP_OAUTH_SCOPE).optional(),
});
export type OAuthRegistration = z.infer<typeof oauthRegistrationSchema>;

export const oauthAuthorizeSchema = z.object({
  client_id: z.string().uuid(),
  redirect_uri: z.string().max(2048),
  response_type: z.literal('code'),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal('S256'),
  resource: z.string().url().max(2048),
  scope: z.string().max(256).default(MCP_OAUTH_SCOPE),
  state: z.string().max(2048).optional(),
});
export type OAuthAuthorization = z.infer<typeof oauthAuthorizeSchema>;
export const oauthConsentSchema = oauthAuthorizeSchema.extend({
  decision: z.enum(['approve', 'deny']),
});
export const oauthConsentPreviewSchema = z.object({
  clientId: z.string().uuid(),
  clientName: z.string(),
  redirectOrigin: z.string(),
  scope: z.string(),
});
export const oauthConsentResultSchema = z.object({ redirectUrl: z.string().url() });
export const oauthGrantSchema = z.object({
  id: z.string().uuid(),
  clientId: z.string().uuid(),
  clientName: z.string(),
  scope: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export const oauthGrantListSchema = z.object({ items: z.array(oauthGrantSchema) });
export type OAuthGrantDto = z.infer<typeof oauthGrantSchema>;

export const oauthTokenRequestSchema = z.object({
  grant_type: z.enum(['authorization_code', 'refresh_token']),
  client_id: z.string().uuid().optional(),
  client_secret: z.string().max(512).optional(),
  code: z.string().max(512).optional(),
  redirect_uri: z.string().max(2048).optional(),
  code_verifier: z.string().max(128).optional(),
  refresh_token: z.string().max(512).optional(),
  resource: z.string().url().max(2048),
  scope: z.string().max(256).optional(),
});
export type OAuthTokenRequest = z.infer<typeof oauthTokenRequestSchema>;
export const oauthRevocationSchema = z.object({
  token: z.string().min(1).max(512),
  client_id: z.string().uuid().optional(),
  client_secret: z.string().max(512).optional(),
  token_type_hint: z.string().max(64).optional(),
});
