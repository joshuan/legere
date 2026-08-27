import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  changePasswordResponseSchema,
  createApiTokenResponseSchema,
  createInviteResponseSchema,
  listSessionsResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const NEXT_PASSWORD = 'an-even-better-passphrase';

// Looking after your own account (docs/07 §7.3, docs/08 §8.1.6a, §8.2): an authenticated password
// rotation, and the sessions it ends — listed and revocable by the person they belong to.
describe('Account: password and sessions (e2e)', () => {
  let app: TestApp;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    seq += 1;
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

  async function inviteUser(adminCookie: string, email: string): Promise<string> {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', adminCookie);
    const token = expectData(created, createInviteResponseSchema).url.split('/').pop() ?? '';
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

  async function signIn(email: string, password = PASSWORD): Promise<string> {
    const res = await api(app).post('/api/auth/login', { email, password }).expect(200);
    const sid = cookieNamed(res, 'sid');
    if (sid === undefined) throw new Error('login did not set a session cookie');
    return sid;
  }

  describe('POST /api/me/password', () => {
    it('changes the password, keeps this session, and ends every other one', async () => {
      const email = `rotate${seq}@legere.local`;
      const first = await onboard(email);
      const second = await signIn(email);
      const third = await signIn(email);

      const changed = await api(app)
        .post('/api/me/password', { currentPassword: PASSWORD, newPassword: NEXT_PASSWORD })
        .set('Cookie', second)
        .expect(200);
      // Onboarding's session and the third sign-in; the one that asked survives.
      expect(expectData(changed, changePasswordResponseSchema)).toEqual({ revoked: 2 });

      await api(app).get('/api/me').set('Cookie', second).expect(200);
      for (const dead of [first, third]) {
        const refused = await api(app).get('/api/me').set('Cookie', dead).expect(401);
        expect(expectError(refused).code).toBe('UNAUTHENTICATED');
      }

      // The old password no longer signs in; the new one does.
      const stale = await api(app).post('/api/auth/login', { email, password: PASSWORD });
      expect(stale.status).toBe(401);
      await api(app).post('/api/auth/login', { email, password: NEXT_PASSWORD }).expect(200);
    });

    it('refuses a wrong current password and leaves the account exactly as it was', async () => {
      const email = `wrong${seq}@legere.local`;
      const cookie = await onboard(email);

      const refused = await api(app)
        .post('/api/me/password', {
          currentPassword: 'not-the-password',
          newPassword: NEXT_PASSWORD,
        })
        .set('Cookie', cookie)
        .expect(401);
      expect(expectError(refused).code).toBe('INVALID_CREDENTIALS');

      await api(app).post('/api/auth/login', { email, password: PASSWORD }).expect(200);
      const sessions = await testPrisma().session.findMany({ where: { revokedAt: null } });
      expect(sessions.length).toBeGreaterThan(0);
    });

    it('holds the new password to the same rule as one chosen at sign-up', async () => {
      const cookie = await onboard(`weak${seq}@legere.local`);

      for (const newPassword of ['short', 'password123', PASSWORD]) {
        const refused = await api(app)
          .post('/api/me/password', { currentPassword: PASSWORD, newPassword })
          .set('Cookie', cookie)
          .expect(422);
        expect(expectError(refused).code).toBe('VALIDATION_FAILED');
      }
    });

    it('is not reachable without a session at all', async () => {
      const refused = await api(app)
        .post('/api/me/password', { currentPassword: PASSWORD, newPassword: NEXT_PASSWORD })
        .expect(401);
      expect(expectError(refused).code).toBe('UNAUTHENTICATED');
    });

    // 🔒 SEC-54. The route verifies an Argon2 hash before it can fail, and that verification queues
    // at the one concurrency gate of two that login shares. Unbudgeted, one signed-in account could
    // fill that queue from a route no throttler covered and nobody on the instance could sign in
    // (docs/08 §8.4). The count is the latency claim, stated without a clock: exactly `limit`
    // verifications are ever handed to the gate, whatever the caller sends.
    it('refuses a replay past its budget without letting it reach the hasher, and login is unmoved', async () => {
      const throttled = await createTestApp({ passwordThrottle: { ttl: 60_000, limit: 3 } });
      try {
        const email = `flood${seq}@legere.local`;
        await api(throttled).post('/api/auth/register/start', { email });
        const verified = await api(throttled).post('/api/auth/register/verify', {
          email,
          code: throttled.emails.lastCodeFor(email),
        });
        await api(throttled).post('/api/auth/register/complete', {
          ticket: expectData(verified, registerVerifyResponseSchema).ticket,
          password: PASSWORD,
        });
        const cookie = cookieNamed(
          await api(throttled).post('/api/auth/login', { email, password: PASSWORD }).expect(200),
          'sid',
        );

        const statuses: number[] = [];
        for (let attempt = 1; attempt <= 10; attempt += 1) {
          const res = await api(throttled)
            .post('/api/me/password', {
              currentPassword: 'not-the-password',
              newPassword: NEXT_PASSWORD,
            })
            .set('Cookie', cookie ?? '');
          statuses.push(res.status);
        }

        // Three reached the hasher and were refused on the merits; the other seven never got there.
        expect(statuses.filter((status) => status === 401)).toHaveLength(3);
        expect(statuses.filter((status) => status === 429)).toHaveLength(7);

        // And signing in is exactly as available as it was before the replay started.
        await api(throttled).post('/api/auth/login', { email, password: PASSWORD }).expect(200);
      } finally {
        await throttled.close();
      }
    });
  });

  describe('GET /api/me/sessions and DELETE /api/me/sessions/:id', () => {
    it('lists only this user live sessions and marks the one asking', async () => {
      const email = `list${seq}@legere.local`;
      const adminCookie = await onboard(email);
      await signIn(email);
      await inviteUser(adminCookie, `other${seq}@legere.local`);

      const listed = await api(app)
        .get('/api/me/sessions')
        .set('Cookie', adminCookie)
        .set('User-Agent', 'vitest')
        .expect(200);
      const items = expectData(listed, listSessionsResponseSchema).items;

      // Two of their own; the invited user's session belongs to somebody else and is not here.
      expect(items).toHaveLength(2);
      expect(items.filter((item) => item.current)).toHaveLength(1);
      // Newest first (docs/08 §8.2), and nothing that could be used to replay a session.
      expect(items[0]?.current).toBe(false);
      expect(JSON.stringify(items)).not.toContain('tokenHash');
    });

    it('revokes a chosen session and answers 404 for somebody else', async () => {
      const email = `revoke${seq}@legere.local`;
      const adminCookie = await onboard(email);
      const doomed = await signIn(email);
      const strangerCookie = await inviteUser(adminCookie, `stranger${seq}@legere.local`);

      const listed = await api(app).get('/api/me/sessions').set('Cookie', adminCookie);
      const target = expectData(listed, listSessionsResponseSchema).items.find(
        (item) => !item.current,
      );

      await api(app)
        .delete(`/api/me/sessions/${target?.id ?? ''}`)
        .set('Cookie', adminCookie)
        .expect(200);
      const dead = await api(app).get('/api/me').set('Cookie', doomed).expect(401);
      expect(expectError(dead).code).toBe('UNAUTHENTICATED');
      // Revoking twice is not an error; the session is dead either way.
      await api(app)
        .delete(`/api/me/sessions/${target?.id ?? ''}`)
        .set('Cookie', adminCookie)
        .expect(200);

      // 🔒 Somebody else's session is not found rather than forbidden (docs/08 §8.2).
      const refused = await api(app)
        .delete(`/api/me/sessions/${target?.id ?? ''}`)
        .set('Cookie', strangerCookie)
        .expect(404);
      expect(expectError(refused).code).toBe('SESSION_NOT_FOUND');
    });

    it('lets the owner sign this device out, clearing the cookie with it', async () => {
      const email = `self${seq}@legere.local`;
      const cookie = await onboard(email);

      const listed = await api(app).get('/api/me/sessions').set('Cookie', cookie);
      const current = expectData(listed, listSessionsResponseSchema).items.find(
        (item) => item.current,
      );

      const revoked = await api(app)
        .delete(`/api/me/sessions/${current?.id ?? ''}`)
        .set('Cookie', cookie)
        .expect(200);
      expect(cookieNamed(revoked, 'sid')).toContain('sid=;');
      await api(app).get('/api/me').set('Cookie', cookie).expect(401);
    });

    it('is a session-only surface: a read-only token reaches neither route', async () => {
      const cookie = await onboard(`token${seq}@legere.local`);
      const created = await api(app)
        .post('/api/me/api-tokens', { name: 'reader' })
        .set('Cookie', cookie);
      const token = expectData(created, createApiTokenResponseSchema).token;

      // Listing is a read, so the read-only middleware lets it through; the refusal comes from the
      // route needing a session at all — a token has none, and "which of these is you" has no
      // answer for it (docs/08 §8.2). It is a refusal, not a crash.
      const listed = await api(app)
        .get('/api/me/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect(expectError(listed).code).toBe('FORBIDDEN');

      // The token still reads what it is for, so nothing above was a general refusal.
      await api(app).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);

      for (const mutation of [
        api(app).delete('/api/me/sessions/00000000-0000-4000-8000-000000000000'),
        api(app).post('/api/me/password', {
          currentPassword: PASSWORD,
          newPassword: NEXT_PASSWORD,
        }),
      ]) {
        const refused = await mutation.set('Authorization', `Bearer ${token}`).expect(403);
        expect(expectError(refused).code).toBe('READ_ONLY_TOKEN');
      }
    });
  });
});
