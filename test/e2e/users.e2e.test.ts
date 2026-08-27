import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  adminUserDtoSchema,
  createInviteResponseSchema,
  listUsersResponseSchema,
  revokeSessionsResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Profile settings and the admin user lifecycle (docs/07 §7.3, docs/08 §8.3, docs/03 §3.3.1).
describe('Me and admin user management (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let adminEmail: string;
  // Fresh addresses per test: the per-email send cap is in-memory and outlives truncation.
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    seq += 1;
    adminEmail = `admin${seq}@legere.local`;
    adminCookie = await onboard(adminEmail);
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

  // Adds a second account through an invite and returns its id and session cookie.
  async function inviteUser(
    email: string,
    role: 'ADMIN' | 'USER' = 'USER',
  ): Promise<{ id: string; cookie: string }> {
    const created = await api(app).post('/api/admin/invites', { role }).set('Cookie', adminCookie);
    const url = expectData(created, createInviteResponseSchema).url;
    const token = url.split('/').pop() ?? '';

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
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return { id: expectData(completed, userDtoSchema).id, cookie };
  }

  describe('GET/PATCH /api/me', () => {
    it('returns the signed-in user and never their hash', async () => {
      const res = await api(app).get('/api/me').set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, userDtoSchema)).toMatchObject({ email: adminEmail, role: 'ADMIN' });
      expect(JSON.stringify(res.body)).not.toContain('argon2');
    });

    it('requires a session', async () => {
      const res = await api(app).get('/api/me');
      expect(res.status).toBe(401);
      expect(expectError(res).code).toBe('UNAUTHENTICATED');
    });

    it('updates the profile and refreshes the locale cookie', async () => {
      const res = await api(app)
        .patch('/api/me', { displayName: 'Ada', language: 'RU', theme: 'DARK' })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, userDtoSchema)).toMatchObject({
        displayName: 'Ada',
        language: 'RU',
        theme: 'DARK',
      });

      // SSR follows the new language (docs/10 §10.3).
      expect(cookieNamed(res, 'NEXT_LOCALE')).toContain('NEXT_LOCALE=ru');

      const persisted = await api(app).get('/api/me').set('Cookie', adminCookie);
      expect(expectData(persisted, userDtoSchema).displayName).toBe('Ada');
    });

    it('leaves absent fields unchanged and rejects an empty or invalid patch', async () => {
      await api(app).patch('/api/me', { displayName: 'Ada' }).set('Cookie', adminCookie);
      const res = await api(app).patch('/api/me', { theme: 'LIGHT' }).set('Cookie', adminCookie);

      expect(expectData(res, userDtoSchema)).toMatchObject({ displayName: 'Ada', theme: 'LIGHT' });

      const empty = await api(app).patch('/api/me', {}).set('Cookie', adminCookie);
      expect(empty.status).toBe(422);
      expect(expectError(empty).code).toBe('VALIDATION_FAILED');

      const bogus = await api(app).patch('/api/me', { theme: 'NEON' }).set('Cookie', adminCookie);
      expect(bogus.status).toBe(422);
    });
  });

  describe('GET /api/admin/users', () => {
    it('lists users oldest first and paginates by cursor', async () => {
      await inviteUser('second@legere.local');
      await inviteUser('third@legere.local');

      const firstPage = await api(app).get('/api/admin/users?limit=2').set('Cookie', adminCookie);
      expect(firstPage.status).toBe(200);
      const page1 = expectData(firstPage, listUsersResponseSchema);
      expect(page1.items.map((user) => user.email)).toEqual([adminEmail, 'second@legere.local']);
      expect(page1.nextCursor).not.toBeNull();

      const secondPage = await api(app)
        .get(`/api/admin/users?limit=2&cursor=${encodeURIComponent(page1.nextCursor ?? '')}`)
        .set('Cookie', adminCookie);
      const page2 = expectData(secondPage, listUsersResponseSchema);
      expect(page2.items.map((user) => user.email)).toEqual(['third@legere.local']);
      expect(page2.nextCursor).toBeNull();
    });

    it('is refused for a non-admin and for an anonymous caller', async () => {
      const user = await inviteUser('plain@legere.local');

      const asUser = await api(app).get('/api/admin/users').set('Cookie', user.cookie);
      expect(asUser.status).toBe(403);
      expect(expectError(asUser).code).toBe('FORBIDDEN');

      const anonymous = await api(app).get('/api/admin/users');
      expect(anonymous.status).toBe(401);
      expect(expectError(anonymous).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('role changes', () => {
    it('promotes and demotes a user', async () => {
      const user = await inviteUser('promote@legere.local');

      const promoted = await api(app)
        .patch(`/api/admin/users/${user.id}`, { role: 'ADMIN' })
        .set('Cookie', adminCookie);
      expect(expectData(promoted, adminUserDtoSchema).role).toBe('ADMIN');

      const demoted = await api(app)
        .patch(`/api/admin/users/${user.id}`, { role: 'USER' })
        .set('Cookie', adminCookie);
      expect(expectData(demoted, adminUserDtoSchema).role).toBe('USER');
    });

    it('refuses to demote the last admin', async () => {
      const admin = await testPrisma().user.findFirstOrThrow({ where: { email: adminEmail } });

      const res = await api(app)
        .patch(`/api/admin/users/${admin.id}`, { role: 'USER' })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('LAST_ADMIN');
      const unchanged = await testPrisma().user.findFirstOrThrow({ where: { id: admin.id } });
      expect(unchanged.role).toBe('ADMIN');
    });

    it('allows demoting an admin once a second one exists', async () => {
      const other = await inviteUser('coadmin@legere.local', 'ADMIN');
      const admin = await testPrisma().user.findFirstOrThrow({ where: { email: adminEmail } });

      const res = await api(app)
        .patch(`/api/admin/users/${admin.id}`, { role: 'USER' })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, adminUserDtoSchema).role).toBe('USER');
      // The other admin is still there, so the instance never lost its administrator.
      const remaining = await testPrisma().user.findFirstOrThrow({ where: { id: other.id } });
      expect(remaining.role).toBe('ADMIN');
    });

    it('404s for an unknown user', async () => {
      const res = await api(app)
        .patch('/api/admin/users/11111111-1111-4111-8111-111111111111', { role: 'USER' })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('USER_NOT_FOUND');

      const malformed = await api(app)
        .post('/api/admin/users/not-a-uuid/deactivate')
        .set('Cookie', adminCookie);
      expect(malformed.status).toBe(404);
      expect(expectError(malformed).code).toBe('USER_NOT_FOUND');
    });
  });

  describe('deactivate / reactivate', () => {
    it('blocks a user, kills their sessions and invalidates their reset links', async () => {
      const user = await inviteUser('blockme@legere.local');
      const reset = await api(app)
        .post(`/api/admin/users/${user.id}/password-reset`)
        .set('Cookie', adminCookie);
      expect(reset.status).toBe(201);

      const res = await api(app)
        .post(`/api/admin/users/${user.id}/deactivate`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, adminUserDtoSchema).deactivatedAt).not.toBeNull();

      // Sessions are gone and the old cookie no longer works.
      const active = await testPrisma().session.count({
        where: { userId: user.id, revokedAt: null },
      });
      expect(active).toBe(0);
      // 401, not 403: deactivation revoked the session, so the credential itself is gone. (A user
      // blocked while a session is still live answers 403 — covered in the login suite.)
      const withOldCookie = await api(app).get('/api/me').set('Cookie', user.cookie);
      expect(withOldCookie.status).toBe(401);

      // The pending reset link is dead too (docs/03 §3.3.1).
      const pendingResets = await testPrisma().passwordReset.count({
        where: { userId: user.id, revokedAt: null, usedAt: null },
      });
      expect(pendingResets).toBe(0);

      // Login is refused.
      const login = await api(app).post('/api/auth/login', {
        email: 'blockme@legere.local',
        password: PASSWORD,
      });
      expect(login.status).toBe(403);
    });

    it('reactivates a blocked user so they can sign in again', async () => {
      const user = await inviteUser('comeback@legere.local');
      await api(app).post(`/api/admin/users/${user.id}/deactivate`).set('Cookie', adminCookie);

      const res = await api(app)
        .post(`/api/admin/users/${user.id}/reactivate`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, adminUserDtoSchema).deactivatedAt).toBeNull();

      const login = await api(app).post('/api/auth/login', {
        email: 'comeback@legere.local',
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
    });

    it('refuses to deactivate the last admin', async () => {
      const admin = await testPrisma().user.findFirstOrThrow({ where: { email: adminEmail } });

      const res = await api(app)
        .post(`/api/admin/users/${admin.id}/deactivate`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('LAST_ADMIN');
      const stillActive = await testPrisma().user.findFirstOrThrow({ where: { id: admin.id } });
      expect(stillActive.deactivatedAt).toBeNull();
    });
  });

  describe('session revocation', () => {
    it('signs a user out everywhere without blocking them', async () => {
      const user = await inviteUser('sessions@legere.local');
      await api(app).post('/api/auth/login', {
        email: 'sessions@legere.local',
        password: PASSWORD,
      });

      const res = await api(app)
        .post(`/api/admin/users/${user.id}/revoke-sessions`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, revokeSessionsResponseSchema).revoked).toBe(2);

      // The old cookie is dead, but signing in again works — the account is not blocked.
      expect((await api(app).get('/api/me').set('Cookie', user.cookie)).status).toBe(401);
      const login = await api(app).post('/api/auth/login', {
        email: 'sessions@legere.local',
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
    });
  });
});
