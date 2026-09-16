import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { uploadDocumentResponseSchema } from '../../src/shared/contracts/documents';
import type { ApiTokenScope } from '../../src/shared/contracts/enums';
import { uploadReceiptResponseSchema } from '../../src/shared/contracts/receipts';
import {
  createApiTokenResponseSchema,
  createInviteResponseSchema,
  createPasswordResetResponseSchema,
  listApiTokensResponseSchema,
  listUsersResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, tokenFromFragmentUrl, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Read-only API tokens end to end (docs/07 §7.3, docs/08 §8.2a).
describe('API tokens (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`tokens${seq}@legere.local`);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function onboard(email: string): Promise<string> {
    await api(app).post('/api/auth/register/start', { email });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('onboarding did not set a session cookie');
    return sid;
  }

  async function inviteUser(email: string): Promise<string> {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', adminCookie);
    const token = tokenFromFragmentUrl(expectData(created, createInviteResponseSchema).url);
    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('invited user did not get a session cookie');
    return sid;
  }

  async function issue(
    cookie: string,
    name = 'export script',
    scope: ApiTokenScope = 'READ',
  ): Promise<string> {
    const created = await api(app)
      .post('/api/me/api-tokens', { name, scope })
      .set('Cookie', cookie)
      .expect(201);
    return expectData(created, createApiTokenResponseSchema).token;
  }

  it('accepts a document attachment without browser credentials and deduplicates retries', async () => {
    const token = await issue(adminCookie, 'mail documents', 'DOCUMENTS_INGEST');
    const send = () =>
      request(app.baseUrl)
        .post('/api/incoming/documents')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Legere-Filename', encodeURIComponent('Договор.txt'))
        // The raw body must survive even an incorrect JSON content type.
        .set('Content-Type', 'application/json')
        .send(Buffer.from('Rental agreement from email'));

    const uploaded = expectData(await send().expect(201), uploadDocumentResponseSchema);
    expect(uploaded.created).toBe(true);
    expect(uploaded.document.title).toBe('Договор');
    const duplicate = expectData(await send().expect(201), uploadDocumentResponseSchema);
    expect(duplicate.created).toBe(false);
    expect(duplicate.document.id).toBe(uploaded.document.id);
    await api(app)
      .get(`/api/documents/${uploaded.document.id}`)
      .set('Cookie', adminCookie)
      .expect(200);
  });

  it('accepts a multipart receipt under its token owner without Origin or cookies', async () => {
    const token = await issue(adminCookie, 'mail receipts', 'RECEIPTS_INGEST');
    const response = await request(app.baseUrl)
      .post('/api/incoming/receipts')
      .set('Authorization', `Bearer ${token}`)
      .field('text', 'Receipt from email')
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'), {
        filename: 'receipt.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const uploaded = expectData(response, uploadReceiptResponseSchema);
    expect(uploaded.created).toBe(true);
    await api(app)
      .get(`/api/receipts/${uploaded.receipt.id}`)
      .set('Cookie', adminCookie)
      .expect(200);
  });

  it.each([
    { scope: 'DOCUMENTS_INGEST', path: 'documents', other: 'receipts' },
    { scope: 'RECEIPTS_INGEST', path: 'receipts', other: 'documents' },
  ] as const)('enforces the $scope boundary and revocation', async ({ scope, path, other }) => {
    const token = await issue(adminCookie, scope, scope);
    const readToken = await issue(adminCookie);
    await request(app.baseUrl)
      .post(`/api/incoming/${path}`)
      .set('Authorization', `Bearer ${readToken}`)
      .expect(403);
    await request(app.baseUrl)
      .post(`/api/incoming/${other}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await api(app).post(`/api/incoming/${path}`).set('Cookie', adminCookie).expect(401);
    await request(app.baseUrl).post(`/api/incoming/${path}`).expect(401);
    for (const endpoint of ['/api/me', '/api/documents', '/api/admin/users']) {
      await api(app).get(endpoint).set('Authorization', `Bearer ${token}`).expect(403);
    }
    await request(app.baseUrl)
      .post('/api/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(403);

    const listed = expectData(
      await api(app).get('/api/me/api-tokens').set('Cookie', adminCookie),
      listApiTokensResponseSchema,
    );
    const id = listed.items.find((item) => item.scope === scope)?.id;
    expect(id).toBeDefined();
    await api(app).delete(`/api/me/api-tokens/${id}`).set('Cookie', adminCookie).expect(200);
    await request(app.baseUrl)
      .post(`/api/incoming/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('reads as its owner and shows the secret exactly once', async () => {
    const created = await api(app)
      .post('/api/me/api-tokens', { name: 'export script', expiresInDays: 7 })
      .set('Cookie', adminCookie);
    const issued = expectData(created, createApiTokenResponseSchema);

    expect(issued.token.startsWith('legere_')).toBe(true);
    expect(issued.apiToken.status).toBe('ACTIVE');
    expect(issued.apiToken.lastUsedAt).toBeNull();

    const withToken = await api(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${issued.token}`)
      .expect(200);
    expect(expectData(withToken, userDtoSchema).id).toBe(
      expectData(await api(app).get('/api/me').set('Cookie', adminCookie), userDtoSchema).id,
    );

    // The listing knows the token, and knows nothing that would let anybody use it.
    const listed = await api(app).get('/api/me/api-tokens').set('Cookie', adminCookie).expect(200);
    const items = expectData(listed, listApiTokensResponseSchema).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(items)).not.toContain(issued.token);
  });

  it('is refused on every mutating method, before the route is even reached', async () => {
    const token = await issue(adminCookie);

    for (const attempt of [
      api(app).post('/api/collections', { name: 'from a token' }),
      api(app).patch('/api/me', { displayName: 'Renamed' }),
      api(app).delete('/api/me/api-tokens/00000000-0000-4000-8000-000000000000'),
      // Not even a route that exists nowhere: the header alone decides (docs/08 §8.2a).
      api(app).post('/api/nothing-here'),
    ]) {
      const refused = await attempt.set('Authorization', `Bearer ${token}`).expect(403);
      expect(expectError(refused).code).toBe('READ_ONLY_TOKEN');
    }

    // A bearer header refuses the mutation even when the token behind it is nonsense.
    const forged = await api(app)
      .post('/api/collections', { name: 'forged' })
      .set('Authorization', 'Bearer legere_not-a-real-token')
      .expect(403);
    expect(expectError(forged).code).toBe('READ_ONLY_TOKEN');

    // And the session that issued it still works, so nothing above was a general refusal.
    await api(app)
      .patch('/api/me', { displayName: 'Renamed' })
      .set('Cookie', adminCookie)
      .expect(200);
  });

  it('carries the owner authority and no more', async () => {
    const userCookie = await inviteUser(`plain${seq}@legere.local`);
    const adminToken = await issue(adminCookie, 'admin token');
    const userToken = await issue(userCookie, 'user token');

    await api(app).get('/api/admin/users').set('Authorization', `Bearer ${adminToken}`).expect(200);

    const refused = await api(app)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(403);
    expect(expectError(refused).code).toBe('FORBIDDEN');
  });

  it('stops working when revoked, when expired, and when its owner is deactivated', async () => {
    const revokedToken = await issue(adminCookie, 'to be revoked');
    const listed = await api(app).get('/api/me/api-tokens').set('Cookie', adminCookie);
    const id = expectData(listed, listApiTokensResponseSchema).items[0]?.id ?? '';

    await api(app).delete(`/api/me/api-tokens/${id}`).set('Cookie', adminCookie).expect(200);
    const afterRevoke = await api(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${revokedToken}`)
      .expect(401);
    expect(expectError(afterRevoke).code).toBe('UNAUTHENTICATED');
    // Revoking again is not an error; the token is dead either way.
    await api(app).delete(`/api/me/api-tokens/${id}`).set('Cookie', adminCookie).expect(200);

    const expiring = await issue(adminCookie, 'about to expire');
    await testPrisma().apiToken.updateMany({
      where: { name: 'about to expire' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await api(app).get('/api/me').set('Authorization', `Bearer ${expiring}`).expect(401);

    // A deactivated owner takes their tokens with them (docs/03 §3.3.22).
    const userCookie = await inviteUser(`blocked${seq}@legere.local`);
    const userToken = await issue(userCookie, 'user token');
    const users = await api(app).get('/api/admin/users').set('Cookie', adminCookie);
    const target = expectData(users, listUsersResponseSchema).items.find((item) =>
      item.email.startsWith('blocked'),
    );
    await api(app)
      .post(`/api/admin/users/${target?.id ?? ''}/deactivate`)
      .set('Cookie', adminCookie)
      .expect(200);

    // Deactivation revokes the credential itself, so the token reads as unknown rather than as
    // belonging to a blocked account — dead for the better of the two reasons (docs/03 §3.3.22).
    const afterBlock = await api(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(401);
    expect(expectError(afterBlock).code).toBe('UNAUTHENTICATED');
  });

  // 🔒 SEC-65: the product's one remediation has to remediate. A stranger who held a session for a
  // minute could mint one of these, good for up to a year, and the documented recovery — an
  // admin-issued reset link, completed by its owner — used to end every session, change the
  // password and leave that credential reading the archive (docs/08 §8.1.6).
  it('does not survive the password reset an admin issued to take the account back', async () => {
    const email = `compromised${seq}@legere.local`;
    const userCookie = await inviteUser(email);
    const stolen = await issue(userCookie, 'sync');
    await api(app).get('/api/me').set('Authorization', `Bearer ${stolen}`).expect(200);

    const users = await api(app).get('/api/admin/users').set('Cookie', adminCookie);
    const target = expectData(users, listUsersResponseSchema).items.find(
      (item) => item.email === email,
    );
    const created = await api(app)
      .post(`/api/admin/users/${target?.id ?? ''}/password-reset`)
      .set('Cookie', adminCookie)
      .expect(201);
    const resetToken = tokenFromFragmentUrl(
      expectData(created, createPasswordResetResponseSchema).url,
    );

    app.emails.reset();
    await api(app).post('/api/auth/register/start', { email, resetToken });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
      resetToken,
    });
    await api(app)
      .post('/api/auth/register/complete', {
        ticket: expectData(verified, registerVerifyResponseSchema).ticket,
        password: 'a-brand-new-passphrase',
      })
      .expect(200);

    const afterReset = await api(app)
      .get('/api/me')
      .set('Authorization', `Bearer ${stolen}`)
      .expect(401);
    expect(expectError(afterReset).code).toBe('UNAUTHENTICATED');
  });

  it('will not surface or revoke somebody else token', async () => {
    const userCookie = await inviteUser(`stranger${seq}@legere.local`);
    await issue(adminCookie, 'admin token');
    const listed = await api(app).get('/api/me/api-tokens').set('Cookie', adminCookie);
    const adminTokenId = expectData(listed, listApiTokensResponseSchema).items[0]?.id ?? '';

    const strangersView = await api(app).get('/api/me/api-tokens').set('Cookie', userCookie);
    expect(expectData(strangersView, listApiTokensResponseSchema).items).toEqual([]);

    const refused = await api(app)
      .delete(`/api/me/api-tokens/${adminTokenId}`)
      .set('Cookie', userCookie)
      .expect(404);
    expect(expectError(refused).code).toBe('API_TOKEN_NOT_FOUND');
  });

  it('needs a session of its own: a token cannot mint a token', async () => {
    const token = await issue(adminCookie);

    const refused = await api(app)
      .post('/api/me/api-tokens', { name: 'a second one' })
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(expectError(refused).code).toBe('READ_ONLY_TOKEN');
  });
});
