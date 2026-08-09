import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  logoutResponseSchema,
  registerVerifyResponseSchema,
  userDtoSchema,
} from '../../src/shared/contracts/auth';
import { api, APP_ORIGIN, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Login, sessions, CSRF and rate limiting (docs/08 §8.1.4, §8.2, §8.4).
describe('Login and sessions (e2e)', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  // Creates the first admin through the real registration flow and returns their session cookie.
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

  const login = (body: Record<string, unknown>) => api(app).post('/api/auth/login', body);

  it('signs a registered user in and sets a session cookie with the documented attributes', async () => {
    const email = 'admin@legere.local';
    await onboard(email);

    const res = await login({ email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(expectData(res, userDtoSchema)).toMatchObject({ email, role: 'ADMIN' });

    const sid = cookieNamed(res, 'sid');
    expect(sid).toBeDefined();
    expect(sid).toContain('HttpOnly');
    expect(sid).toContain('SameSite=Lax');
    expect(sid).toContain('Path=/');
    // Secure is production-only (docs/08 §8.2); tests run with NODE_ENV=test.
    expect(sid).not.toContain('Secure');
  });

  it('issues a brand-new session on every login (anti-fixation)', async () => {
    const email = 'fixation@legere.local';
    const onboardingCookie = await onboard(email);

    const first = await login({ email, password: PASSWORD });
    const second = await login({ email, password: PASSWORD });

    const firstSid = cookieNamed(first, 'sid');
    const secondSid = cookieNamed(second, 'sid');
    expect(firstSid).not.toBe(secondSid);
    expect(firstSid).not.toBe(onboardingCookie);

    // Three distinct sessions now exist for this user; none was reused.
    const user = await testPrisma().user.findFirstOrThrow({ where: { email } });
    const sessions = await testPrisma().session.findMany({ where: { userId: user.id } });
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map((session) => session.tokenHash)).size).toBe(3);
  });

  it('answers identically for an unknown address and a wrong password', async () => {
    await onboard('known@legere.local');

    const unknownEmail = await login({ email: 'nobody@legere.local', password: PASSWORD });
    const wrongPassword = await login({
      email: 'known@legere.local',
      password: 'wrong-passphrase',
    });

    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(expectError(unknownEmail)).toEqual(expectError(wrongPassword));
    expect(expectError(unknownEmail).code).toBe('INVALID_CREDENTIALS');
    expect(cookieNamed(unknownEmail, 'sid')).toBeUndefined();
    expect(cookieNamed(wrongPassword, 'sid')).toBeUndefined();
  });

  it('populates the caller from the session cookie and revokes it on logout', async () => {
    const sid = await onboard('logout@legere.local');

    // The session guard resolves the caller: logout revokes exactly this session.
    const loggedOut = await api(app).post('/api/auth/logout').set('Cookie', sid);
    expect(loggedOut.status).toBe(200);
    expect(expectData(loggedOut, logoutResponseSchema)).toEqual({ ok: true });
    expect(cookieNamed(loggedOut, 'sid')).toContain('sid=;');

    const stored = await testPrisma().session.findFirstOrThrow();
    expect(stored.revokedAt).not.toBeNull();

    // The revoked cookie no longer authenticates.
    const afterLogout = await api(app).post('/api/auth/logout').set('Cookie', sid);
    expect(afterLogout.status).toBe(401);
    expect(expectError(afterLogout).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a request with no session cookie at all', async () => {
    const res = await api(app).post('/api/auth/logout');

    expect(res.status).toBe(401);
    expect(expectError(res).code).toBe('UNAUTHENTICATED');
  });

  it('refuses a deactivated user at login and on an existing session', async () => {
    const email = 'blocked@legere.local';
    const sid = await onboard(email);
    await testPrisma().user.updateMany({ where: { email }, data: { deactivatedAt: new Date() } });

    // Correct credentials, but the account is blocked.
    const loginAttempt = await login({ email, password: PASSWORD });
    expect(loginAttempt.status).toBe(403);
    expect(expectError(loginAttempt).code).toBe('FORBIDDEN');

    // A session issued before the block stops working too.
    const withOldSession = await api(app).post('/api/auth/logout').set('Cookie', sid);
    expect(withOldSession.status).toBe(403);
    expect(expectError(withOldSession).code).toBe('FORBIDDEN');
  });

  it('backs off after five failed attempts for one address', async () => {
    const email = 'backoff@legere.local';
    await onboard(email);

    // The first four are plain refusals; the fifth opens the backoff window (docs/08 §8.4).
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await login({ email, password: 'wrong-passphrase' });
      expect(res.status).toBe(401);
    }
    const throttled = await login({ email, password: 'wrong-passphrase' });
    expect(throttled.status).toBe(429);
    expect(expectError(throttled).code).toBe('RATE_LIMITED');

    // Another address is unaffected — the backoff is per email, not global.
    const other = await login({ email: 'someone-else@legere.local', password: PASSWORD });
    expect(other.status).toBe(401);
  });

  // 🔒 SEC-12: knowing an address used to be enough to keep its owner out for ever, because the
  // streak was consulted before the password was (docs/08 §8.4).
  it('lets the owner sign in while somebody else is failing against their address', async () => {
    const email = 'victim@legere.local';
    await onboard(email);

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      await login({ email, password: 'wrong-passphrase' });
    }
    // Deep enough that the old backoff had reached its fifteen-minute cap.
    expect((await login({ email, password: 'wrong-passphrase' })).status).toBe(429);

    const signedIn = await login({ email, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(cookieNamed(signedIn, 'sid')).toBeDefined();
  });

  it('clears the failure streak after a successful login', async () => {
    const email = 'recover@legere.local';
    await onboard(email);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await login({ email, password: 'wrong-passphrase' });
    }
    expect((await login({ email, password: PASSWORD })).status).toBe(200);

    // The streak is gone: four more failures still do not trigger the backoff.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await login({ email, password: 'wrong-passphrase' })).status).toBe(401);
    }
    expect((await login({ email, password: PASSWORD })).status).toBe(200);
  });

  // 🔒 The streak must not become an oracle: an address nobody registered has to reach the backoff
  // on the same failure and answer the same thing (docs/08 §8.1.4).
  it('backs an unknown address off exactly as it backs off one that exists', async () => {
    const email = 'known-here@legere.local';
    await onboard(email);

    const known: number[] = [];
    const unknown: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      known.push((await login({ email, password: 'wrong-passphrase' })).status);
      unknown.push(
        (await login({ email: 'nobody-here@legere.local', password: 'wrong-passphrase' })).status,
      );
    }

    expect(unknown).toEqual(known);
    expect(known).toEqual([401, 401, 401, 401, 429, 429]);
  });

  describe('CSRF (fail-closed origin check)', () => {
    it('rejects a mutation with no Origin or Referer', async () => {
      const res = await request(app.baseUrl)
        .post('/api/auth/login')
        .send({ email: 'admin@legere.local', password: PASSWORD });

      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
    });

    it('rejects a mutation from a foreign origin', async () => {
      const res = await request(app.baseUrl)
        .post('/api/auth/login')
        .set('Origin', 'https://evil.example.com')
        .send({ email: 'admin@legere.local', password: PASSWORD });

      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
    });

    it('accepts a same-origin mutation proven by Referer alone', async () => {
      const email = 'referer@legere.local';
      await onboard(email);

      const res = await request(app.baseUrl)
        .post('/api/auth/login')
        .set('Referer', `${APP_ORIGIN}/login`)
        .send({ email, password: PASSWORD });

      expect(res.status).toBe(200);
    });

    it('leaves reads alone', async () => {
      const res = await request(app.baseUrl).get('/api/auth/onboarding');
      expect(res.status).toBe(200);
    });

    it('guards every mutating method, not just POST', async () => {
      const res = await request(app.baseUrl).patch('/api/me').send({ language: 'RU' });
      // Refused by CSRF before routing, so a route that does not exist yet still answers 403.
      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
    });

    // 🔒 docs/08 §8.4: the check is mounted above the `/api` dispatcher, not on `/api`. Nothing
    // outside `/api` accepts a mutation today — the handler below is the stub standing in for Next
    // — and that is precisely why this holds now: the day a route handler or a server action is
    // added, it inherits the origin check instead of inheriting the session cookie without one.
    it('guards a mutation that never reaches /api at all', async () => {
      const refused = await request(app.baseUrl).post('/whatever-next-may-serve').send({});
      expect(refused.status).toBe(403);
      expect(expectError(refused).code).toBe('FORBIDDEN');

      const allowed = await request(app.baseUrl)
        .post('/whatever-next-may-serve')
        .set('Origin', APP_ORIGIN)
        .send({});
      expect(allowed.status).toBe(200);
    });
  });

  describe('per-IP throttling', () => {
    it('refuses further /api/auth requests from one address once the budget is spent', async () => {
      const throttled = await createTestApp({ throttle: { ttl: 60_000, limit: 3 } });
      try {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const res = await request(throttled.server).get('/api/auth/onboarding');
          expect(res.status).toBe(200);
        }

        const blocked = await request(throttled.server).get('/api/auth/onboarding');
        expect(blocked.status).toBe(429);
        expect(expectError(blocked).code).toBe('RATE_LIMITED');

        // Health is outside the throttled surface (docs/07 §7.3: not rate-limited).
        const health = await request(throttled.server).get('/api/health');
        expect(health.status).toBe(200);
      } finally {
        await throttled.close();
      }
    });
  });
});
