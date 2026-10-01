import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { AuthenticateApiToken } from '../../src/server/application/auth/authenticate-api-token';
import { actorOf } from '../../src/server/presentation/auth/current-user';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  oauthConsentPreviewSchema,
  oauthConsentResultSchema,
  oauthGrantListSchema,
} from '../../src/shared/contracts/oauth';
import {
  createApiTokenResponseSchema,
  listApiTokensResponseSchema,
  createPasswordResetResponseSchema,
} from '../../src/shared/contracts/users';
import { api, APP_ORIGIN, createTestApp, tokenFromFragmentUrl, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { expectData } from '../helpers/http';
import { onboardIdentity } from '../helpers/identity';

const registrationSchema = z.object({
  client_id: z.string().uuid(),
  client_secret: z.string().optional(),
  token_endpoint_auth_method: z.string(),
});
const tokensSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number(),
  scope: z.literal('mcp:read'),
});
const resource = `${APP_ORIGIN}/api/mcp`;
const redirectUri = 'https://agent.example/callback';
const verifier = 'test-verifier-with-at-least-forty-three-characters-0123456789';
const challenge = createHash('sha256').update(verifier).digest('base64url');

describe('MCP OAuth delegation (e2e)', () => {
  let app: TestApp;
  let cookie: string;
  let sequence = 0;
  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    cookie = await onboardIdentity(app, `oauth${sequence++}@legere.local`);
  });
  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function register(method = 'none') {
    const response = await request(app.baseUrl)
      .post('/api/oauth/register')
      .send({
        client_name: 'Cloud agent',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: method,
      })
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    return registrationSchema.parse(response.body);
  }
  function authorization(clientId: string) {
    return {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      scope: 'mcp:read',
      state: 'client-state',
    };
  }
  async function approve(clientId: string) {
    const res = await api(app)
      .post('/api/oauth/authorize', { ...authorization(clientId), decision: 'approve' })
      .set('Cookie', cookie)
      .expect(200);
    const url = new URL(expectData(res, oauthConsentResultSchema).redirectUrl);
    expect(url.origin).toBe(new URL(redirectUri).origin);
    expect(url.searchParams.get('state')).toBe('client-state');
    expect(url.searchParams.get('iss')).toBe(APP_ORIGIN);
    const code = url.searchParams.get('code');
    if (code === null) throw new Error('No authorization code');
    return code;
  }
  const exchange = (clientId: string, code: string, overrides: Record<string, string> = {}) =>
    request(app.baseUrl)
      .post('/api/oauth/token')
      .type('form')
      .send({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource,
        ...overrides,
      });
  const refresh = (clientId: string, token: string, overrides: Record<string, string> = {}) =>
    request(app.baseUrl)
      .post('/api/oauth/token')
      .type('form')
      .send({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: token,
        resource,
        ...overrides,
      });
  const mcp = (token?: string) => {
    const req = request(app.baseUrl)
      .post('/api/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
  };

  it('publishes discovery from the unauthenticated MCP challenge and root paths', async () => {
    const res = await mcp().expect(401);
    expect(res.headers['www-authenticate']).toContain(
      `${APP_ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
    );
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/mcp',
    ]) {
      expect((await request(app.baseUrl).get(path).expect(200)).body).toMatchObject({
        resource,
        authorization_servers: [APP_ORIGIN],
        scopes_supported: ['mcp:read'],
      });
    }
    expect(
      (await request(app.baseUrl).get('/.well-known/oauth-authorization-server').expect(200)).body,
    ).toMatchObject({
      issuer: APP_ORIGIN,
      authorization_endpoint: `${APP_ORIGIN}/oauth/authorize`,
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${APP_ORIGIN}/api/oauth/register`,
    });
  });

  it('registers, previews consent, authorizes with PKCE, calls MCP and persists a stable app identity', async () => {
    const client = await register();
    expect(client.client_secret).toBeUndefined();
    const preview = expectData(
      await api(app)
        .get('/api/oauth/authorize/preview')
        .query(authorization(client.client_id))
        .set('Cookie', cookie)
        .expect(200),
      oauthConsentPreviewSchema,
    );
    expect(preview).toEqual({
      clientId: client.client_id,
      clientName: 'Cloud agent',
      redirectOrigin: 'https://agent.example',
      scope: 'mcp:read',
    });
    const code = await approve(client.client_id);
    expect((await testPrisma().oAuthCode.findFirstOrThrow()).hash).not.toBe(code);
    const res = await exchange(client.client_id, code).expect(200);
    const tokens = tokensSchema.parse(res.body);
    expect(tokens.expires_in).toBeLessThanOrEqual(900);
    expect(res.headers['cache-control']).toBe('no-store');
    await mcp(tokens.access_token).expect(200);
    await request(app.baseUrl)
      .get('/api/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .expect(405);
    for (const path of [
      '/api/documents',
      '/api/me/api-tokens',
      '/api/integrations/documents',
      '/api/me/oauth-grants',
    ]) {
      await request(app.baseUrl)
        .get(path)
        .set('Authorization', `Bearer ${tokens.access_token}`)
        .expect(403);
    }
    await request(app.baseUrl)
      .post('/api/incoming/documents')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .expect(403);
    const grants = expectData(
      await api(app).get('/api/me/oauth-grants').set('Cookie', cookie),
      oauthGrantListSchema,
    );
    expect(grants.items).toMatchObject([
      { clientId: client.client_id, clientName: 'Cloud agent', scope: 'mcp:read', revokedAt: null },
    ]);
    const access = await testPrisma().apiToken.findFirstOrThrow();
    expect(access).toMatchObject({
      name: 'Cloud agent',
      scope: 'MCP',
      oauthGrantId: grants.items[0]?.id,
    });
    expect(access.tokenHash).not.toBe(tokens.access_token);
    expect(
      actorOf(await app.nestApp.get(AuthenticateApiToken).execute(tokens.access_token)).agent,
    ).toEqual({
      kind: 'OAUTH',
      id: access.oauthGrantId,
      name: 'Cloud agent',
      clientId: client.client_id,
    });
    expect(
      expectData(
        await api(app).get('/api/me/api-tokens').set('Cookie', cookie),
        listApiTokensResponseSchema,
      ).items,
    ).toHaveLength(0);
  });

  it('rotates refresh tokens and revokes the entire grant when an old refresh is reused', async () => {
    const client = await register();
    const first = tokensSchema.parse(
      (await exchange(client.client_id, await approve(client.client_id)).expect(200)).body,
    );
    const second = tokensSchema.parse(
      (await refresh(client.client_id, first.refresh_token).expect(200)).body,
    );
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await mcp(second.access_token).expect(200);
    expect((await refresh(client.client_id, first.refresh_token).expect(400)).body).toMatchObject({
      error: 'invalid_grant',
    });
    await mcp(second.access_token).expect(401);
    await mcp(first.access_token).expect(401);
    await refresh(client.client_id, second.refresh_token).expect(400);
  });

  it.each(['code', 'refresh'] as const)(
    'serializes concurrent %s redemption and commits replay revocation',
    async (kind) => {
      const client = await register();
      const code = await approve(client.client_id);
      const first =
        kind === 'refresh'
          ? tokensSchema.parse((await exchange(client.client_id, code).expect(200)).body)
          : null;
      const redeem = () =>
        first === null
          ? exchange(client.client_id, code)
          : refresh(client.client_id, first.refresh_token);
      const replies = await Promise.all([redeem(), redeem()]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 400]);
      const winner = replies.find((reply) => reply.status === 200);
      if (winner === undefined) throw new Error('No successful exchange');
      await mcp(tokensSchema.parse(winner.body).access_token).expect(401);
      expect((await testPrisma().oAuthGrant.findFirstOrThrow()).revokedAt).not.toBeNull();
    },
  );

  it.each(['client_secret_basic', 'client_secret_post'])(
    'supports %s confidential clients and rejects wrong secrets',
    async (method) => {
      const client = await register(method);
      const code = await approve(client.client_id);
      if (client.client_secret === undefined) throw new Error('Missing client secret');
      const row = await testPrisma().oAuthClient.findUniqueOrThrow({
        where: { id: client.client_id },
      });
      expect(row.secretHash).not.toBe(client.client_secret);
      await exchange(client.client_id, code).expect(401);
      await exchange(client.client_id, code, { client_secret: 'wrong' }).expect(401);
      const res =
        method === 'client_secret_post'
          ? await exchange(client.client_id, code, { client_secret: client.client_secret }).expect(
              200,
            )
          : await exchange(client.client_id, code)
              .auth(client.client_id, client.client_secret)
              .expect(200);
      await mcp(tokensSchema.parse(res.body).access_token).expect(200);
    },
  );

  it('denies without issuing a grant and does not redirect unregistered targets', async () => {
    const client = await register();
    const denied = expectData(
      await api(app)
        .post('/api/oauth/authorize', { ...authorization(client.client_id), decision: 'deny' })
        .set('Cookie', cookie)
        .expect(200),
      oauthConsentResultSchema,
    );
    expect(new URL(denied.redirectUrl).searchParams.get('error')).toBe('access_denied');
    expect(await testPrisma().oAuthGrant.count()).toBe(0);
    for (const changes of [
      { redirect_uri: 'https://evil.example/callback' },
      { resource: `${APP_ORIGIN}/api/documents` },
      { scope: 'admin' },
      { client_id: randomUUID() },
      { code_challenge_method: 'plain' },
    ]) {
      await api(app)
        .post('/api/oauth/authorize', {
          ...authorization(client.client_id),
          ...changes,
          decision: 'approve',
        })
        .set('Cookie', cookie)
        .expect(400);
    }
    expect(await testPrisma().oAuthGrant.count()).toBe(0);
  });

  it('requires a browser session and same-origin consent; API tokens and cookies alone cannot call MCP', async () => {
    const client = await register();
    const payload = { ...authorization(client.client_id), decision: 'approve' };
    await api(app).post('/api/oauth/authorize', payload).expect(401);
    await request(app.baseUrl)
      .post('/api/oauth/authorize')
      .set('Cookie', cookie)
      .send(payload)
      .expect(403);
    await request(app.baseUrl)
      .post('/api/oauth/authorize')
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send(payload)
      .expect(403);
    const token = expectData(
      await api(app)
        .post('/api/me/api-tokens', { name: 'Read token' })
        .set('Cookie', cookie)
        .expect(201),
      createApiTokenResponseSchema,
    ).token;
    await api(app)
      .post('/api/oauth/authorize', payload)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await api(app)
      .get('/api/oauth/authorize/preview')
      .query(authorization(client.client_id))
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await mcp().set('Cookie', cookie).expect(401);
    await mcp(token).expect(200);
  });

  it('rejects wrong PKCE, redirects, audiences and other clients without consuming the valid code', async () => {
    const client = await register();
    const other = await register();
    const code = await approve(client.client_id);
    for (const changes of [
      { code_verifier: 'x'.repeat(43) },
      { code_verifier: 'short' },
      { redirect_uri: `${redirectUri}/extra` },
      { resource: 'https://evil.example/api/mcp' },
      { scope: 'documents:write' },
      { code: 'unknown' },
      { client_id: other.client_id },
    ]) {
      await exchange(client.client_id, code, changes).expect(400);
    }
    await exchange(client.client_id, code).expect(200);
  });

  it.each(['access', 'refresh', 'settings'] as const)(
    'revokes a connection through %s and leaves the operation idempotent',
    async (kind) => {
      const client = await register();
      const tokens = tokensSchema.parse(
        (await exchange(client.client_id, await approve(client.client_id)).expect(200)).body,
      );
      if (kind === 'settings') {
        const grant = await testPrisma().oAuthGrant.findFirstOrThrow();
        const foreignCookie = await onboardIdentity(app, 'foreign@legere.local', cookie);
        await api(app)
          .delete(`/api/me/oauth-grants/${grant.id}`)
          .set('Cookie', foreignCookie)
          .expect(404);
        await api(app).delete(`/api/me/oauth-grants/${grant.id}`).set('Cookie', cookie).expect(200);
      } else {
        const token = kind === 'access' ? tokens.access_token : tokens.refresh_token;
        const other = await register();
        await request(app.baseUrl)
          .post('/api/oauth/revoke')
          .type('form')
          .send({ client_id: other.client_id, token })
          .expect(200);
        await mcp(tokens.access_token).expect(200);
        for (let repeat = 0; repeat < 2; repeat++)
          await request(app.baseUrl)
            .post('/api/oauth/revoke')
            .type('form')
            .send({ client_id: client.client_id, token })
            .expect(200);
      }
      await mcp(tokens.access_token).expect(401);
      await refresh(client.client_id, tokens.refresh_token).expect(400);
    },
  );

  it.each(['code', 'refresh', 'grant', 'access', 'user', 'audience'] as const)(
    'rejects expired or invalid %s bindings',
    async (kind) => {
      const client = await register();
      const code = await approve(client.client_id);
      const expired = new Date(0);
      if (kind === 'code') {
        await testPrisma().oAuthCode.updateMany({ data: { expiresAt: expired } });
        await exchange(client.client_id, code).expect(400);
        return;
      }
      const tokens = tokensSchema.parse((await exchange(client.client_id, code).expect(200)).body);
      if (kind === 'refresh')
        await testPrisma().oAuthRefreshToken.updateMany({ data: { expiresAt: expired } });
      if (kind === 'grant')
        await testPrisma().oAuthGrant.updateMany({ data: { expiresAt: expired } });
      if (kind === 'access')
        await testPrisma().apiToken.updateMany({ data: { expiresAt: expired } });
      if (kind === 'user')
        await testPrisma().user.updateMany({ data: { deactivatedAt: new Date() } });
      if (kind === 'audience')
        await testPrisma().oAuthGrant.updateMany({
          data: { resource: 'https://other.example/api/mcp' },
        });
      if (kind !== 'refresh')
        await mcp(tokens.access_token).expect(kind === 'audience' || kind === 'user' ? 403 : 401);
      if (kind !== 'access') await refresh(client.client_id, tokens.refresh_token).expect(400);
    },
  );

  it.each(['reset', 'deactivate'] as const)(
    'ends OAuth grants through account %s and cannot refresh them afterwards',
    async (action) => {
      const adminCookie = cookie;
      const email = `recover${sequence}@legere.local`;
      cookie = await onboardIdentity(app, email, adminCookie);
      const owner = await testPrisma().user.findFirstOrThrow({ where: { email } });
      const client = await register();
      const tokens = tokensSchema.parse(
        (await exchange(client.client_id, await approve(client.client_id)).expect(200)).body,
      );
      if (action === 'deactivate') {
        await api(app)
          .post(`/api/admin/users/${owner.id}/deactivate`)
          .set('Cookie', adminCookie)
          .expect(200);
      } else {
        const reset = expectData(
          await api(app)
            .post(`/api/admin/users/${owner.id}/password-reset`)
            .set('Cookie', adminCookie)
            .expect(201),
          createPasswordResetResponseSchema,
        );
        const resetToken = tokenFromFragmentUrl(reset.url);
        await api(app).post('/api/auth/register/start', { email, resetToken }).expect(200);
        const verification = expectData(
          await api(app)
            .post('/api/auth/register/verify', {
              email,
              resetToken,
              code: app.emails.lastCodeFor(email),
            })
            .expect(200),
          registerVerifyResponseSchema,
        );
        await api(app)
          .post('/api/auth/register/complete', {
            ticket: verification.ticket,
            password: 'replacement-password-for-recovery',
          })
          .expect(200);
      }
      expect(
        (await testPrisma().oAuthGrant.findFirstOrThrow({ where: { userId: owner.id } })).revokedAt,
      ).not.toBeNull();
      await mcp(tokens.access_token).expect(401);
      await refresh(client.client_id, tokens.refresh_token).expect(400);
      cookie = adminCookie;
    },
  );

  it('validates client registration, form encoding, grant type and malformed client authentication', async () => {
    for (const redirect of [
      'http://agent.example/cb',
      'javascript:alert(1)',
      'https://user:pass@agent.example/cb',
      'https://agent.example/cb#fragment',
      'bad',
    ]) {
      expect(
        (
          await request(app.baseUrl)
            .post('/api/oauth/register')
            .send({ redirect_uris: [redirect] })
            .expect(400)
        ).body,
      ).toMatchObject({ error: 'invalid_client_metadata' });
    }
    await request(app.baseUrl)
      .post('/api/oauth/register')
      .send({ redirect_uris: ['http://127.0.0.1:9010/callback'] })
      .expect(201);
    await request(app.baseUrl)
      .post('/api/oauth/register')
      .send({ redirect_uris: [redirectUri], grant_types: ['refresh_token'] })
      .expect(400);
    await request(app.baseUrl)
      .post('/api/oauth/token')
      .send({ grant_type: 'authorization_code' })
      .expect(400);
    expect(
      (
        await request(app.baseUrl)
          .post('/api/oauth/token')
          .type('form')
          .send({ grant_type: 'password' })
          .expect(400)
      ).body,
    ).toMatchObject({ error: 'unsupported_grant_type' });
    for (const auth of [
      'Basic !!!',
      `Basic ${Buffer.from('not-a-uuid:secret').toString('base64')}`,
      `Basic ${Buffer.from('%ZZ:secret').toString('base64')}`,
      `Basic ${Buffer.from('no-colon').toString('base64')}`,
    ]) {
      await request(app.baseUrl)
        .post('/api/oauth/token')
        .set('Authorization', auth)
        .type('form')
        .send({ grant_type: 'refresh_token', refresh_token: 'unknown', resource })
        .expect(401);
    }
    await request(app.baseUrl)
      .post('/api/oauth/token')
      .type('form')
      .send({ grant_type: 'refresh_token', refresh_token: 'unknown', resource })
      .expect(401);
    const client = await register();
    await refresh(client.client_id, 'unknown').expect(400);
    await request(app.baseUrl)
      .post('/api/oauth/revoke')
      .type('form')
      .send({ client_id: client.client_id, token: 'unknown' })
      .expect(200);
  });

  it('enforces the public client-registration ceiling atomically across concurrent requests', async () => {
    await testPrisma().$executeRaw`INSERT INTO oauth_clients(id, name, redirect_uris, auth_method)
      SELECT gen_random_uuid(), 'Capacity fixture', ARRAY['https://agent.example/callback'], 'none'
      FROM generate_series(1, 9999)`;
    const registerOne = () =>
      request(app.baseUrl)
        .post('/api/oauth/register')
        .send({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' });
    const responses = await Promise.all([registerOne(), registerOne()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 503]);
    expect(await testPrisma().oAuthClient.count()).toBe(10_000);
  });
});
