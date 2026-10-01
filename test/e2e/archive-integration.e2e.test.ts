import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  archiveDocumentListSchema,
  archiveDocumentSchema,
  archiveSubjectSchema,
} from '../../src/shared/contracts/archive-integration';
import {
  oauthConsentPreviewSchema,
  oauthConsentResultSchema,
} from '../../src/shared/contracts/oauth';
import {
  integrationArtifactSchema,
  integrationSchema,
  integrationTokenResponseSchema,
} from '../../src/shared/contracts/integrations';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  createPasswordResetResponseSchema,
  createApiTokenResponseSchema,
} from '../../src/shared/contracts/users';
import { api, tokenFromFragmentUrl, APP_ORIGIN, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument, seedLibrary } from '../helpers/documents';
import { expectData, expectError } from '../helpers/http';
import { onboardIdentity } from '../helpers/identity';

const root = '/api/integrations/archive';
const resource = `${APP_ORIGIN}${root}`;
const callback = 'https://rent.example/legere/callback';
const verifier = 'rent-manage-pkce-verifier-012345678901234567890123456789';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clientSchema = z.object({
  client_id: z.string().uuid(),
  client_secret: z.string(),
  scope: z.string(),
});
type Client = z.infer<typeof clientSchema>;
const tokensSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().positive().max(900),
    scope: z.literal('documents:read'),
  })
  .strict();

describe('Personal archive references (e2e, docs/19)', () => {
  let app: TestApp;
  let cookie: string;
  let subject: string;
  let sequence = 0;
  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    app.files.clear();
    cookie = await onboardIdentity(app, `archive${sequence++}@legere.local`);
    subject = (await testPrisma().user.findFirstOrThrow()).id;
  });
  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function register(scope = 'documents:read') {
    const res = await request(app.baseUrl)
      .post('/api/oauth/register')
      .send({
        client_name: 'Rent Manage',
        redirect_uris: [callback],
        scope,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      })
      .expect(201);
    return clientSchema.parse(res.body);
  }
  function authorization(client: Client, overrides: Record<string, string> = {}) {
    return {
      client_id: client.client_id,
      redirect_uri: callback,
      response_type: 'code',
      scope: client.scope,
      resource: client.scope === 'mcp:read' ? `${APP_ORIGIN}/api/mcp` : resource,
      state: 'session-bound-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...overrides,
    };
  }
  async function approve(client: Client, session = cookie) {
    const res = await api(app)
      .post('/api/oauth/authorize', { ...authorization(client), decision: 'approve' })
      .set('Cookie', session)
      .expect(200);
    const url = new URL(expectData(res, oauthConsentResultSchema).redirectUrl);
    expect(url.searchParams.get('iss')).toBe(APP_ORIGIN);
    expect(url.searchParams.get('state')).toBe('session-bound-state');
    const code = url.searchParams.get('code');
    if (code === null) throw new Error('Missing authorization code');
    return code;
  }
  const exchange = (client: Client, code: string, overrides: Record<string, string> = {}) =>
    request(app.baseUrl)
      .post('/api/oauth/token')
      .auth(client.client_id, client.client_secret)
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: authorization(client).resource,
        ...overrides,
      });
  const refresh = (client: Client, token: string, overrides: Record<string, string> = {}) =>
    request(app.baseUrl)
      .post('/api/oauth/token')
      .auth(client.client_id, client.client_secret)
      .type('form')
      .send({
        grant_type: 'refresh_token',
        refresh_token: token,
        resource,
        ...overrides,
      });
  async function connect(session = cookie) {
    const client = await register();
    const code = await approve(client, session);
    const res = await exchange(client, code).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return { client, ...tokensSchema.parse(res.body) };
  }
  const get = (token: string, suffix = '/documents') =>
    request(app.baseUrl).get(`${root}${suffix}`).set('Authorization', `Bearer ${token}`);

  it('advertises an independent resource and challenges unauthenticated requests without caching', async () => {
    const res = await request(app.baseUrl).get(`${root}/me`).expect(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['www-authenticate']).toContain(
      `${APP_ORIGIN}/.well-known/oauth-protected-resource${root}`,
    );
    expectError(res);
    expect(
      (await request(app.baseUrl).get(`/.well-known/oauth-protected-resource${root}`).expect(200))
        .body,
    ).toMatchObject({
      resource,
      scopes_supported: ['documents:read'],
      authorization_servers: [APP_ORIGIN],
      bearer_methods_supported: ['header'],
    });
    expect(
      (await request(app.baseUrl).get('/.well-known/oauth-authorization-server').expect(200)).body,
    ).toMatchObject({
      scopes_supported: ['mcp:read', 'documents:read'],
      authorization_response_iss_parameter_supported: true,
    });
    await request(app.baseUrl).head(`/.well-known/oauth-protected-resource${root}`).expect(200);
    expect(
      (await request(app.baseUrl).get('/.well-known/oauth-protected-resource/api/mcp')).body,
    ).toMatchObject({
      resource: `${APP_ORIGIN}/api/mcp`,
      scopes_supported: ['mcp:read'],
    });
  });

  it('requires explicit session consent, preserving denial state and issuer without creating a grant', async () => {
    const client = await register();
    expect(client.scope).toBe('documents:read');
    expect(
      (await testPrisma().oAuthClient.findUniqueOrThrow({ where: { id: client.client_id } }))
        .secretHash,
    ).not.toBe(client.client_secret);
    const preview = expectData(
      await api(app)
        .get('/api/oauth/authorize/preview')
        .query(authorization(client))
        .set('Cookie', cookie)
        .expect(200),
      oauthConsentPreviewSchema,
    );
    expect(preview).toMatchObject({
      scope: 'documents:read',
      clientName: 'Rent Manage',
      redirectOrigin: 'https://rent.example',
    });
    await api(app)
      .post('/api/oauth/authorize', { ...authorization(client), decision: 'approve' })
      .expect(401);
    await request(app.baseUrl)
      .post('/api/oauth/authorize')
      .set('Cookie', cookie)
      .send({ ...authorization(client), decision: 'approve' })
      .expect(403);
    const denied = expectData(
      await api(app)
        .post('/api/oauth/authorize', { ...authorization(client), decision: 'deny' })
        .set('Cookie', cookie)
        .expect(200),
      oauthConsentResultSchema,
    );
    const url = new URL(denied.redirectUrl);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('session-bound-state');
    expect(url.searchParams.get('iss')).toBe(APP_ORIGIN);
    expect(url.searchParams.has('code')).toBe(false);
    expect(await testPrisma().oAuthGrant.count()).toBe(0);
  });

  it('binds registration and authorization to exactly one resource/scope and an exact callback', async () => {
    const client = await register();
    for (const changes of [
      { scope: 'mcp:read' },
      { scope: 'documents:read mcp:read' },
      { scope: 'documents:read ' },
      { resource: `${APP_ORIGIN}/api/mcp` },
      { resource: `${resource}/` },
      { resource: `${APP_ORIGIN}/api/mcp`, scope: 'mcp:read' },
      { redirect_uri: `${callback}/` },
      { code_challenge_method: 'plain' },
      { client_id: randomUUID() },
    ]) {
      await api(app)
        .post('/api/oauth/authorize', { ...authorization(client, changes), decision: 'approve' })
        .set('Cookie', cookie)
        .expect(400);
    }
    const mcpClient = await register('mcp:read');
    await api(app)
      .post('/api/oauth/authorize', {
        ...authorization(mcpClient, { resource, scope: 'documents:read' }),
        decision: 'approve',
      })
      .set('Cookie', cookie)
      .expect(400);
    expect(await testPrisma().oAuthGrant.count()).toBe(0);
  });

  it('refuses wrong PKCE, callback, client, resource or scope without consuming a valid code', async () => {
    const client = await register();
    const other = await register();
    const code = await approve(client);
    await exchange(other, code).expect(400);
    await request(app.baseUrl)
      .post('/api/oauth/token')
      .auth(client.client_id, 'wrong')
      .type('form')
      .send({ grant_type: 'authorization_code', code, resource })
      .expect(401);
    for (const changes of [
      { code_verifier: 'wrong'.repeat(12) },
      { redirect_uri: `${callback}/` },
      { resource: `${APP_ORIGIN}/api/mcp` },
      { scope: 'mcp:read' },
      { resource: `${APP_ORIGIN}/api/mcp`, scope: 'mcp:read' },
      { resource: `${resource}/` },
    ])
      await exchange(client, code, changes).expect(400);
    const tokens = tokensSchema.parse((await exchange(client, code).expect(200)).body);
    await get(tokens.access_token, '/me').expect(200);
    await exchange(client, code).expect(400);
    await get(tokens.access_token, '/me').expect(401);
  });

  it('keeps an immutable user subject across refresh, renamed accounts and independent grants', async () => {
    const first = await connect();
    const me = expectData(await get(first.access_token, '/me').expect(200), archiveSubjectSchema);
    expect(me.subject).toBe(subject);
    await testPrisma().user.update({
      where: { id: subject },
      data: { displayName: 'New display name' },
    });
    await refresh(first.client, first.refresh_token, { resource: `${APP_ORIGIN}/api/mcp` }).expect(
      400,
    );
    await refresh(first.client, first.refresh_token, { scope: 'mcp:read' }).expect(400);
    const rotated = tokensSchema.parse(
      (await refresh(first.client, first.refresh_token).expect(200)).body,
    );
    const second = await connect();
    for (const token of [first.access_token, rotated.access_token, second.access_token]) {
      const res = await get(token, '/me').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(expectData(res, archiveSubjectSchema)).toEqual({
        subject,
        displayName: 'New display name',
      });
    }
    await refresh(first.client, first.refresh_token).expect(400);
    await get(rotated.access_token, '/me').expect(401);
    await get(second.access_token, '/me').expect(200);
  });

  it.each(['code', 'refresh'] as const)(
    'revokes the whole grant on concurrent %s replay',
    async (kind) => {
      const client = await register();
      const code = await approve(client);
      const first =
        kind === 'refresh' ? tokensSchema.parse((await exchange(client, code)).body) : null;
      const redeem = () =>
        first === null ? exchange(client, code) : refresh(client, first.refresh_token);
      const replies = await Promise.all([redeem(), redeem()]);
      expect(replies.map((res) => res.status).sort()).toEqual([200, 400]);
      const winner = replies.find((res) => res.status === 200);
      if (winner === undefined) throw new Error('No winning exchange');
      await get(tokensSchema.parse(winner.body).access_token, '/me').expect(401);
    },
  );

  it('refuses cookies and all other credential types on all five archive routes', async () => {
    const personal = expectData(
      await api(app)
        .post('/api/me/api-tokens', { name: 'Personal' })
        .set('Cookie', cookie)
        .expect(201),
      createApiTokenResponseSchema,
    );
    const integration = expectData(
      await api(app)
        .post('/api/me/integrations', { name: 'Namespace' })
        .set('Cookie', cookie)
        .expect(201),
      integrationSchema,
    );
    const service = expectData(
      await api(app)
        .post(`/api/me/integrations/${integration.id}/tokens`, { name: 'Backend' })
        .set('Cookie', cookie)
        .expect(201),
      integrationTokenResponseSchema,
    );
    const client = await register('mcp:read');
    const mcp = z
      .object({ access_token: z.string() })
      .parse((await exchange(client, await approve(client)).expect(200)).body);
    const doc = await seedDocument({ document: { createdById: subject } });
    for (const path of [
      '/me',
      '/documents',
      `/documents/${doc.id}`,
      `/documents/${doc.id}/canonical`,
      `/documents/${doc.id}/preview`,
    ]) {
      await request(app.baseUrl)
        .get(root + path)
        .set('Cookie', cookie)
        .expect(401);
      for (const token of [personal.token, service.token, mcp.access_token]) {
        const res = await get(token, path).expect(403);
        expect(expectError(res)).toMatchObject({ code: 'FORBIDDEN', details: null });
      }
    }
    for (const scope of ['ARCHIVE', 'MCP'])
      await api(app)
        .post('/api/me/api-tokens', { name: 'Forged', scope })
        .set('Cookie', cookie)
        .expect(422);
  });

  it('grants no ordinary REST, MCP, credential management or mutation access', async () => {
    const token = (await connect()).access_token;
    for (const path of [
      '/api/documents',
      '/api/receipts',
      '/api/me',
      '/api/me/api-tokens',
      '/api/me/integrations',
      '/api/integrations/documents',
      '/api/search?q=test',
    ])
      await request(app.baseUrl).get(path).set('Authorization', `Bearer ${token}`).expect(403);
    for (const path of [
      '/api/documents',
      '/api/receipts',
      '/api/me/api-tokens',
      '/api/integrations/documents',
      '/api/mcp',
    ])
      await request(app.baseUrl)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        .expect(403);
    await api(app)
      .delete(`/api/documents/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it.each(['ADMIN', 'USER'] as const)(
    'excludes foreign, shared, library, receipt, deleted and namespace documents for a %s',
    async (role) => {
      const otherCookie = await onboardIdentity(app, `other${sequence++}@legere.local`, cookie);
      const other = await testPrisma().user.findFirstOrThrow({ where: { id: { not: subject } } });
      const owner = role === 'ADMIN' ? subject : other.id;
      const token = (await connect(role === 'ADMIN' ? cookie : otherCookie)).access_token;
      const owned = await seedDocument({ document: { createdById: owner, title: 'Eligible' } });
      const foreign = await seedDocument({
        document: { createdById: role === 'ADMIN' ? other.id : subject },
      });
      await testPrisma().collection.create({
        data: {
          ownerId: role === 'ADMIN' ? other.id : subject,
          name: 'Shared with everyone',
          items: {
            create: { documentId: foreign.id, addedById: role === 'ADMIN' ? other.id : subject },
          },
          shares: { create: { granteeUserId: null } },
        },
      });
      const library = await seedLibrary();
      const scanned = await seedDocument({ libraryId: library });
      const mixed = await seedDocument({
        document: { createdById: owner },
        files: [{ origin: 'MANAGED' }, { libraryId: library }],
      });
      const deleted = await seedDocument({
        document: { createdById: owner, deletedAt: new Date() },
      });
      const namespaced = await seedDocument({ document: { createdById: owner } });
      const integration = await testPrisma().integration.create({
        data: { userId: owner, name: 'Service' },
      });
      await testPrisma().archiveItem.update({
        where: { id: namespaced.id },
        data: { integrationId: integration.id },
      });
      const receiptId = randomUUID();
      const receiptFile = await testPrisma().file.create({
        data: {
          contentHash: randomUUID(),
          origin: 'MANAGED',
          storageKey: 'private/receipt',
          mimeType: 'image/jpeg',
          ext: 'jpg',
          sizeBytes: 1,
          name: 'receipt.jpg',
        },
      });
      await testPrisma().archiveItem.create({
        data: {
          id: receiptId,
          kind: 'RECEIPT',
          createdById: owner,
          receipt: { create: { fileId: receiptFile.id } },
        },
      });
      const page = expectData(
        await get(token).query({ limit: 1 }).expect(200),
        archiveDocumentListSchema,
      );
      expect(page.items.map((doc) => doc.id)).toEqual([owned.id]);
      expect(page.nextCursor).toBeNull();
      for (const id of [
        foreign.id,
        scanned.id,
        mixed.id,
        deleted.id,
        namespaced.id,
        receiptId,
        randomUUID(),
      ]) {
        for (const suffix of ['', '/canonical', '/preview']) {
          const res = await get(token, `/documents/${id}${suffix}`).expect(404);
          expect(expectError(res)).toEqual({
            code: 'DOCUMENT_NOT_FOUND',
            message: 'Resource not found',
            details: null,
          });
          expect(res.headers['cache-control']).toBe('no-store');
        }
      }
    },
  );

  it('returns only the bounded DTO, with nullable type/date and no source or OCR information', async () => {
    const token = (await connect()).access_token;
    const type = await testPrisma().documentType.create({ data: { slug: 'lease', name: 'Lease' } });
    const doc = await seedDocument({
      document: {
        createdById: subject,
        title: 'Lease',
        description: 'Signed lease',
        typeId: type.id,
        documentDate: new Date('2026-01-02T00:00:00Z'),
        pageCount: 4,
        markdown: 'SECRET OCR',
      },
    });
    const dto = expectData(
      await get(token, `/documents/${doc.id}`).expect(200),
      archiveDocumentSchema,
    );
    expect(dto).toMatchObject({
      id: doc.id,
      title: 'Lease',
      description: 'Signed lease',
      documentDate: '2026-01-02',
      pageCount: 4,
      documentType: { id: type.id, slug: 'lease', name: 'Lease' },
      processing: false,
      url: `${APP_ORIGIN}/documents/${doc.id}`,
    });
    expect(JSON.stringify(dto)).not.toContain('SECRET');
    expect(expectData(await get(token).expect(200), archiveDocumentListSchema).items).toEqual([
      dto,
    ]);
    await testPrisma().document.update({
      where: { id: doc.id },
      data: { typeId: null, documentDate: null, description: null, pageCount: null },
    });
    expect(
      expectData(await get(token, `/documents/${doc.id}`), archiveDocumentSchema),
    ).toMatchObject({ documentType: null, documentDate: null, description: null, pageCount: null });
  });

  it('searches literal case-insensitive title/description substrings, never SQL wildcard patterns or OCR', async () => {
    const token = (await connect()).access_token;
    const literal = await seedDocument({
      document: {
        createdById: subject,
        title: 'Lease 100%_\\ paid',
        description: 'Договор аренды',
      },
    });
    await seedDocument({
      document: {
        createdById: subject,
        title: 'Lease 1000x paid',
        markdown: 'Invisible query phrase',
      },
    });
    for (const q of [' %_\\ ', 'LEASE 100%', 'дОгОвОр']) {
      expect(
        expectData(await get(token).query({ q }).expect(200), archiveDocumentListSchema).items.map(
          (doc) => doc.id,
        ),
      ).toEqual([literal.id]);
    }
    expect(
      expectData(await get(token).query({ q: 'Invisible query phrase' }), archiveDocumentListSchema)
        .items,
    ).toEqual([]);
    const unicode = await seedDocument({
      document: { createdById: subject, title: 'İSTANBUL residence' },
    });
    expect(
      expectData(
        await get(token).query({ q: 'İSTANBUL' }).expect(200),
        archiveDocumentListSchema,
      ).items.map((doc) => doc.id),
    ).toEqual([unicode.id]);
  });

  it('paginates by exact timestamp and UUID, binding the cursor to subject and normalized search', async () => {
    const token = (await connect()).access_token;
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
    ] as const;
    for (const id of ids)
      await seedDocument({ document: { id, createdById: subject, title: 'Lease' } });
    await testPrisma()
      .$executeRaw`UPDATE archive_items SET created_at = '2026-01-01T00:00:00.123456Z' WHERE created_by_id = ${subject}::uuid`;
    const first = expectData(
      await get(token).query({ q: ' LEASE ', limit: 1 }).expect(200),
      archiveDocumentListSchema,
    );
    expect(first.items.map((doc) => doc.id)).toEqual([ids[2]]);
    expect(first.items[0]?.createdAt).toBe('2026-01-01T00:00:00.123456Z');
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor ?? '';
    const second = expectData(
      await get(token).query({ q: 'lease', cursor, limit: 1 }),
      archiveDocumentListSchema,
    );
    expect(second.items.map((doc) => doc.id)).toEqual([ids[1]]);
    const third = expectData(
      await get(token).query({ q: 'lease', cursor: second.nextCursor, limit: 1 }),
      archiveDocumentListSchema,
    );
    expect(third.items.map((doc) => doc.id)).toEqual([ids[0]]);
    expect(third.nextCursor).toBeNull();
    expect(expectError(await get(token).query({ q: 'other', cursor }).expect(422)).code).toBe(
      'CURSOR_SORT_MISMATCH',
    );
    const otherCookie = await onboardIdentity(app, `cursor${sequence++}@legere.local`, cookie);
    const otherToken = (await connect(otherCookie)).access_token;
    expect(expectError(await get(otherToken).query({ q: 'lease', cursor }).expect(422)).code).toBe(
      'CURSOR_SORT_MISMATCH',
    );
    await testPrisma().document.updateMany({
      where: { id: ids[2] },
      data: { deletedAt: new Date() },
    });
    expect(
      expectData(
        await get(token).query({ q: 'lease', cursor }),
        archiveDocumentListSchema,
      ).items.map((doc) => doc.id),
    ).toEqual([ids[1], ids[0]]);
  });

  it('rejects unknown fields, malformed identifiers and malformed cursors with null error details', async () => {
    const token = (await connect()).access_token;
    for (const query of [
      { owner: subject },
      { integrationId: randomUUID() },
      { sort: 'title' },
      { q: 'x'.repeat(301) },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { cursor: 'invalid' },
      { cursor: '' },
      { q: '\u0000' },
      { cursor: '*' },
      { cursor: Buffer.from('{}').toString('base64url') },
      { q: ['one', 'two'] },
    ])
      expect(expectError(await get(token).query(query).expect(422))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: null,
      });
    for (const path of [
      '/documents/not-a-uuid',
      '/documents/not-a-uuid/canonical',
      '/documents/not-a-uuid/preview',
      '/me?owner=x',
      `/documents/${randomUUID()}?owner=x`,
    ])
      expect(expectError(await get(token, path).expect(422))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: null,
      });
  });

  it('checks artifact readiness independently and rechecks eligibility on every read', async () => {
    const token = (await connect()).access_token;
    const doc = await seedDocument({
      document: { createdById: subject, canonicalStatus: 'DONE', previewStatus: 'FAILED' },
    });
    expect(
      expectData(await get(token, `/documents/${doc.id}`), archiveDocumentSchema).processing,
    ).toBe(false);
    const pdf = expectData(
      await get(token, `/documents/${doc.id}/canonical`).expect(200),
      integrationArtifactSchema,
    );
    expect(pdf.contentType).toBe('application/pdf');
    expect(new URL(pdf.url).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(new URL(pdf.url).searchParams.get('response-content-disposition')).toBe('inline');
    expect(Date.parse(pdf.expiresAt)).toBeGreaterThan(Date.now());
    expect(expectError(await get(token, `/documents/${doc.id}/preview`).expect(409)).code).toBe(
      'DOCUMENT_UNAVAILABLE',
    );
    await testPrisma().document.update({
      where: { id: doc.id },
      data: { canonicalStatus: 'QUEUED', previewStatus: 'DONE', title: 'Updated title' },
    });
    expect(
      expectData(await get(token, `/documents/${doc.id}`), archiveDocumentSchema),
    ).toMatchObject({ processing: true, title: 'Updated title' });
    expect(expectError(await get(token, `/documents/${doc.id}/canonical`).expect(409)).code).toBe(
      'CANONICAL_NOT_READY',
    );
    expect(
      expectData(
        await get(token, `/documents/${doc.id}/preview`).expect(200),
        integrationArtifactSchema,
      ).contentType,
    ).toBe('image/jpeg');
    await testPrisma().file.updateMany({
      where: { id: { in: doc.fileIds } },
      data: { origin: 'LIBRARY', storageKey: null },
    });
    await get(token, `/documents/${doc.id}/preview`).expect(404);
    expect(expectData(await get(token), archiveDocumentListSchema).items).toEqual([]);
  });

  it.each([
    'access-expiry',
    'grant-expiry',
    'revocation',
    'inactive',
    'resource',
    'scope',
  ] as const)('checks live %s on every request', async (change) => {
    const connected = await connect();
    const expired = new Date(Date.now() - 1000);
    if (change === 'access-expiry')
      await testPrisma().apiToken.updateMany({ data: { expiresAt: expired } });
    if (change === 'grant-expiry')
      await testPrisma().oAuthGrant.updateMany({ data: { expiresAt: expired } });
    if (change === 'revocation')
      await testPrisma().oAuthGrant.updateMany({ data: { revokedAt: new Date() } });
    if (change === 'inactive')
      await testPrisma().user.update({
        where: { id: subject },
        data: { deactivatedAt: new Date() },
      });
    if (change === 'resource')
      await testPrisma().oAuthGrant.updateMany({ data: { resource: `${APP_ORIGIN}/api/mcp` } });
    if (change === 'scope')
      await testPrisma().oAuthGrant.updateMany({ data: { scope: 'mcp:read' } });
    const status = ['inactive', 'resource', 'scope'].includes(change) ? 403 : 401;
    await get(connected.access_token, '/me').expect(status);
    await refresh(connected.client, connected.refresh_token).expect(
      change === 'access-expiry' ? 200 : 400,
    );
  });

  it.each(['access', 'refresh', 'settings'] as const)(
    'disconnects the full grant through %s revocation',
    async (kind) => {
      const connected = await connect();
      const grant = await testPrisma().oAuthGrant.findFirstOrThrow();
      if (kind === 'settings')
        await api(app).delete(`/api/me/oauth-grants/${grant.id}`).set('Cookie', cookie).expect(200);
      else
        for (let n = 0; n < 2; n++)
          await request(app.baseUrl)
            .post('/api/oauth/revoke')
            .auth(connected.client.client_id, connected.client.client_secret)
            .type('form')
            .send({ token: kind === 'access' ? connected.access_token : connected.refresh_token })
            .expect(200);
      await get(connected.access_token, '/me').expect(401);
      await refresh(connected.client, connected.refresh_token).expect(400);
    },
  );

  it.each(['reset', 'deactivate'] as const)(
    'revokes archive grants after account %s',
    async (action) => {
      const email = `recovery${sequence++}@legere.local`;
      const ownerCookie = await onboardIdentity(app, email, cookie);
      const owner = await testPrisma().user.findFirstOrThrow({ where: { email } });
      const connected = await connect(ownerCookie);
      if (action === 'deactivate') {
        await api(app)
          .post(`/api/admin/users/${owner.id}/deactivate`)
          .set('Cookie', cookie)
          .expect(200);
      } else {
        const reset = expectData(
          await api(app)
            .post(`/api/admin/users/${owner.id}/password-reset`)
            .set('Cookie', cookie)
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
            password: 'replacement-password-for-archive',
          })
          .expect(200);
      }
      await get(connected.access_token, '/me').expect(401);
      await refresh(connected.client, connected.refresh_token).expect(400);
    },
  );

  it('returns a per-user rate limit with Retry-After and no-store after authenticating', async () => {
    const connected = await connect();
    const limited = await createTestApp({ archiveThrottle: { ttl: 60_000, limit: 1 } });
    try {
      await request(limited.baseUrl)
        .get(`${root}/me`)
        .set('Authorization', `Bearer ${connected.access_token}`)
        .expect(200);
      const res = await request(limited.baseUrl)
        .get(`${root}/me`)
        .set('Authorization', `Bearer ${connected.access_token}`)
        .expect(429);
      expect(expectError(res)).toMatchObject({ code: 'RATE_LIMITED', details: null });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(res.headers['cache-control']).toBe('no-store');
      const otherCookie = await onboardIdentity(app, `throttle${sequence++}@legere.local`, cookie);
      const other = await connect(otherCookie);
      await request(limited.baseUrl)
        .get(`${root}/me`)
        .set('Authorization', `Bearer ${other.access_token}`)
        .expect(200);
    } finally {
      await limited.close();
    }
  });

  it('publishes all five operations with separate OAuth security and strict DTOs', async () => {
    const spec = z
      .object({
        paths: z.record(z.object({ get: z.object({ security: z.unknown() }) }).passthrough()),
        components: z.object({
          securitySchemes: z.record(z.unknown()),
          schemas: z.record(z.unknown()),
        }),
      })
      .parse((await request(app.baseUrl).get('/api/openapi.json')).body);
    for (const suffix of [
      '/me',
      '/documents',
      '/documents/{id}',
      '/documents/{id}/canonical',
      '/documents/{id}/preview',
    ])
      expect(spec.paths[root + suffix]?.get.security).toEqual([
        { personalArchiveOAuth: ['documents:read'] },
      ]);
    expect(spec.components.securitySchemes.personalArchiveOAuth).toMatchObject({ type: 'oauth2' });
    expect(spec.components.schemas.ArchiveDocument).toMatchObject({ additionalProperties: false });
  });
});
