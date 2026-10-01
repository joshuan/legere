import { createHash, timingSafeEqual } from 'node:crypto';
import {
  MCP_OAUTH_SCOPE,
  type OAuthAuthorization,
  type OAuthRegistration,
  type OAuthTokenRequest,
} from '../../../shared/contracts/oauth';
import type {
  OAuthClient,
  OAuthGrant,
  OAuthRepository,
} from '../../domain/repositories/oauth.repository';
import type { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import { isUserActive } from '../../domain/entities/user';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { SessionTokens } from '../ports/session-tokens';
import type { Clock } from '../ports/clock';
import type { UnitOfWork, TransactionHandle } from '../ports/unit-of-work';
import { API_TOKEN_PREFIX } from './authenticate-api-token';

export class OAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'invalid_scope'
      | 'invalid_target'
      | 'unsupported_grant_type'
      | 'invalid_redirect_uri'
      | 'invalid_client_metadata',
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export type OAuthClientCredentials = {
  id?: string | undefined;
  secret?: string | undefined;
  method: 'none' | 'client_secret_basic' | 'client_secret_post';
};
export type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};
const ACCESS_TTL_SEC = 15 * 60;
const GRANT_TTL_MS = 90 * 86_400_000;
const CODE_TTL_MS = 2 * 60_000;

export class OAuth {
  readonly issuer: string;
  readonly resource: string;
  constructor(
    private readonly repository: OAuthRepository,
    private readonly apiTokens: ApiTokenRepository,
    private readonly users: UserRepository,
    private readonly secrets: SessionTokens,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    baseUrl: string,
  ) {
    this.issuer = baseUrl.replace(/\/+$/, '');
    this.resource = `${this.issuer}/api/mcp`;
  }

  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/api/oauth/token`,
      registration_endpoint: `${this.issuer}/api/oauth/register`,
      revocation_endpoint: `${this.issuer}/api/oauth/revoke`,
      scopes_supported: [MCP_OAUTH_SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: [
        'none',
        'client_secret_basic',
        'client_secret_post',
      ],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    };
  }
  resourceMetadata() {
    return {
      resource: this.resource,
      resource_name: 'Legere archive',
      authorization_servers: [this.issuer],
      scopes_supported: [MCP_OAUTH_SCOPE],
      bearer_methods_supported: ['header'],
    };
  }
  async register(input: OAuthRegistration) {
    if (input.grant_types !== undefined && !input.grant_types.includes('authorization_code')) {
      throw new OAuthError('invalid_client_metadata', 'Authorization code grant is required');
    }
    const secret =
      input.token_endpoint_auth_method === 'none' ? null : this.secrets.generate().token;
    const client = await this.repository.register({
      name: input.client_name,
      redirectUris: [...new Set(input.redirect_uris)],
      authMethod: input.token_endpoint_auth_method,
      secretHash: secret === null ? null : this.secrets.hash(secret),
    });
    if (client === null)
      throw new OAuthError(
        'invalid_client_metadata',
        'Client registration capacity reached; contact the instance administrator',
        503,
      );
    return {
      client_id: client.id,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.authMethod,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_OAUTH_SCOPE,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
    };
  }
  async preview(input: OAuthAuthorization) {
    const client = await this.authorizationClient(input);
    return {
      clientId: client.id,
      clientName: client.name,
      redirectOrigin: new URL(input.redirect_uri).origin,
      scope: MCP_OAUTH_SCOPE,
    };
  }
  async authorize(userId: string, input: OAuthAuthorization, decision: 'approve' | 'deny') {
    const client = await this.authorizationClient(input);
    const redirect = new URL(input.redirect_uri);
    redirect.searchParams.set('iss', this.issuer);
    if (input.state !== undefined) redirect.searchParams.set('state', input.state);
    if (decision === 'deny') {
      redirect.searchParams.set('error', 'access_denied');
      return { redirectUrl: redirect.href };
    }
    const now = this.clock.now();
    const code = this.secrets.generate();
    await this.unitOfWork.run(async (tx) => {
      const grant = await this.repository.createGrant(
        {
          userId,
          clientId: client.id,
          clientName: client.name,
          resource: this.resource,
          scope: MCP_OAUTH_SCOPE,
          expiresAt: new Date(now.getTime() + GRANT_TTL_MS),
        },
        tx,
      );
      await this.repository.createCode(
        {
          hash: code.hash,
          grantId: grant.id,
          redirectUri: input.redirect_uri,
          codeChallenge: input.code_challenge,
          expiresAt: new Date(now.getTime() + CODE_TTL_MS),
        },
        tx,
      );
    });
    redirect.searchParams.set('code', code.token);
    return { redirectUrl: redirect.href };
  }

  async token(
    input: OAuthTokenRequest,
    credentials: OAuthClientCredentials,
  ): Promise<OAuthTokenResponse> {
    const client = await this.authenticateClient(credentials);
    this.assertResource(input.resource);
    if (input.scope !== undefined) this.assertScope(input.scope);
    const result = await this.unitOfWork.run(async (tx) => {
      if (input.grant_type === 'authorization_code') return this.exchangeCode(client, input, tx);
      return this.exchangeRefresh(client, input, tx);
    });
    // A replay's revocation must commit before the error is raised.
    if (result instanceof OAuthError) throw result;
    return result;
  }

  async revoke(presented: string, credentials: OAuthClientCredentials): Promise<void> {
    const client = await this.authenticateClient(credentials);
    await this.unitOfWork.run(async (tx) => {
      const hash = this.secrets.hash(presented);
      const refresh = await this.repository.findRefresh(hash, tx);
      const access = refresh === null ? await this.apiTokens.findByTokenHash(hash, tx) : null;
      const grantId = refresh?.grantId ?? access?.oauthGrantId;
      if (grantId == null) return;
      const grant = await this.repository.lockGrant(grantId, tx);
      if (grant?.clientId === client.id)
        await this.repository.revokeGrant(grant.id, this.clock.now(), tx);
    });
  }
  async listGrants(userId: string) {
    return {
      items: (await this.repository.listGrants(userId)).map((grant) => ({
        id: grant.id,
        clientId: grant.clientId,
        clientName: grant.clientName,
        scope: grant.scope,
        createdAt: grant.createdAt.toISOString(),
        expiresAt: grant.expiresAt.toISOString(),
        revokedAt: grant.revokedAt?.toISOString() ?? null,
      })),
    };
  }
  async revokeOwned(userId: string, id: string): Promise<void> {
    await this.unitOfWork.run(async (tx) => {
      const grant = await this.repository.lockGrant(id, tx);
      if (grant === null || grant.userId !== userId) throw new NotFoundError('NOT_FOUND');
      await this.repository.revokeGrant(id, this.clock.now(), tx);
    });
  }

  private async authorizationClient(input: OAuthAuthorization): Promise<OAuthClient> {
    const client = await this.repository.findClient(input.client_id);
    if (client === null) throw new OAuthError('invalid_client', 'Unknown client');
    if (!client.redirectUris.includes(input.redirect_uri))
      throw new OAuthError('invalid_redirect_uri', 'Redirect URI is not registered');
    this.assertResource(input.resource);
    this.assertScope(input.scope);
    return client;
  }
  private assertResource(resource: string): void {
    let canonical: string;
    try {
      canonical = new URL(resource).href;
    } catch {
      throw new OAuthError('invalid_target', 'Invalid resource');
    }
    if (canonical !== this.resource)
      throw new OAuthError(
        'invalid_target',
        'This authorization server only issues MCP resource tokens',
      );
  }
  private assertScope(scope: string): void {
    if (scope.trim() !== MCP_OAUTH_SCOPE)
      throw new OAuthError('invalid_scope', 'Only mcp:read is supported');
  }
  private async authenticateClient(credentials: OAuthClientCredentials): Promise<OAuthClient> {
    if (credentials.id === undefined)
      throw new OAuthError('invalid_client', 'Client authentication is required', 401);
    const client = await this.repository.findClient(credentials.id);
    if (client === null || client.authMethod !== credentials.method)
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    if (
      client.authMethod !== 'none' &&
      (credentials.secret === undefined ||
        client.secretHash === null ||
        !equal(this.secrets.hash(credentials.secret), client.secretHash))
    ) {
      throw new OAuthError('invalid_client', 'Client authentication failed', 401);
    }
    return client;
  }
  private async activeGrant(
    id: string,
    client: OAuthClient,
    tx: TransactionHandle,
  ): Promise<OAuthGrant | null> {
    const grant = await this.repository.lockGrant(id, tx);
    if (
      grant === null ||
      grant.clientId !== client.id ||
      grant.resource !== this.resource ||
      grant.scope !== MCP_OAUTH_SCOPE ||
      grant.revokedAt !== null ||
      grant.expiresAt.getTime() <= this.clock.now().getTime()
    )
      return null;
    const user = await this.users.findById(grant.userId, tx);
    return user !== null && isUserActive(user) ? grant : null;
  }
  private async exchangeCode(
    client: OAuthClient,
    input: OAuthTokenRequest,
    tx: TransactionHandle,
  ): Promise<OAuthTokenResponse | OAuthError> {
    if (
      input.code === undefined ||
      input.redirect_uri === undefined ||
      input.code_verifier === undefined ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)
    )
      return invalidGrant();
    const hash = this.secrets.hash(input.code);
    const found = await this.repository.findCode(hash, tx);
    if (found === null) return invalidGrant();
    const grant = await this.activeGrant(found.grantId, client, tx);
    if (grant === null) return invalidGrant();
    // Read again after acquiring the shared grant lock; a concurrent exchange may have won.
    const code = await this.repository.findCode(hash, tx);
    if (
      code === null ||
      code.redirectUri !== input.redirect_uri ||
      code.expiresAt.getTime() <= this.clock.now().getTime() ||
      !equal(
        createHash('sha256').update(input.code_verifier).digest('base64url'),
        code.codeChallenge,
      )
    )
      return invalidGrant();
    if (code.consumedAt !== null) {
      await this.repository.revokeGrant(grant.id, this.clock.now(), tx);
      return invalidGrant();
    }
    await this.repository.consumeCode(hash, this.clock.now(), tx);
    return this.issue(grant, tx);
  }
  private async exchangeRefresh(
    client: OAuthClient,
    input: OAuthTokenRequest,
    tx: TransactionHandle,
  ): Promise<OAuthTokenResponse | OAuthError> {
    if (input.refresh_token === undefined) return invalidGrant();
    const hash = this.secrets.hash(input.refresh_token);
    const found = await this.repository.findRefresh(hash, tx);
    if (found === null) return invalidGrant();
    const grant = await this.activeGrant(found.grantId, client, tx);
    if (grant === null) return invalidGrant();
    const refresh = await this.repository.findRefresh(hash, tx);
    if (refresh === null || refresh.expiresAt.getTime() <= this.clock.now().getTime())
      return invalidGrant();
    if (refresh.consumedAt !== null) {
      await this.repository.revokeGrant(grant.id, this.clock.now(), tx);
      return invalidGrant();
    }
    await this.repository.consumeRefresh(hash, this.clock.now(), tx);
    return this.issue(grant, tx);
  }
  private async issue(grant: OAuthGrant, tx: TransactionHandle): Promise<OAuthTokenResponse> {
    const token = API_TOKEN_PREFIX + this.secrets.generate().token;
    const refresh = this.secrets.generate();
    const now = this.clock.now();
    const expiresAt = new Date(
      Math.min(now.getTime() + ACCESS_TTL_SEC * 1000, grant.expiresAt.getTime()),
    );
    await this.apiTokens.create(
      {
        userId: grant.userId,
        name: grant.clientName,
        scope: 'MCP',
        oauthGrantId: grant.id,
        tokenHash: this.secrets.hash(token),
        expiresAt,
      },
      tx,
    );
    await this.repository.createRefresh(
      { hash: refresh.hash, grantId: grant.id, expiresAt: grant.expiresAt },
      tx,
    );
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor((expiresAt.getTime() - now.getTime()) / 1000),
      refresh_token: refresh.token,
      scope: grant.scope,
    };
  }
}

function invalidGrant(): OAuthError {
  return new OAuthError('invalid_grant', 'The grant is invalid, expired or already used');
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
