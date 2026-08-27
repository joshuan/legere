import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  onboardingStatusSchema,
  registerStartResponseSchema,
  registerVerifyResponseSchema,
  userDtoSchema,
} from '../../src/shared/contracts/auth';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

// Registration & onboarding end to end (docs/08 §8.1.1–8.1.3, docs/07 register endpoints).
describe('Registration and onboarding (e2e)', () => {
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

  const start = (body: Record<string, unknown>) => api(app).post('/api/auth/register/start', body);
  const verify = (body: Record<string, unknown>) =>
    api(app).post('/api/auth/register/verify', body);
  const complete = (body: Record<string, unknown>) =>
    api(app).post('/api/auth/register/complete', body);

  async function issueTicket(email: string): Promise<string> {
    await start({ email });
    const verified = await verify({ email, code: app.emails.lastCodeFor(email) });
    return expectData(verified, registerVerifyResponseSchema).ticket;
  }

  async function onboardFirstAdmin(email: string): Promise<void> {
    const ticket = await issueTicket(email);
    const completed = await complete({ ticket, password: 'a-decent-passphrase' });
    expect(completed.status).toBe(200);
  }

  it('reports onboarding as required on an empty instance and closed afterwards', async () => {
    const before = await api(app).get('/api/auth/onboarding');
    expect(before.status).toBe(200);
    expect(expectData(before, onboardingStatusSchema)).toEqual({ required: true });

    await onboardFirstAdmin('first@legere.local');

    const after = await api(app).get('/api/auth/onboarding');
    expect(expectData(after, onboardingStatusSchema)).toEqual({ required: false });
  });

  it('walks the three-step happy path and signs the new admin in', async () => {
    const email = 'admin@legere.local';

    const started = await start({ email });
    expect(started.status).toBe(200);
    expect(expectData(started, registerStartResponseSchema).expiresAt).toBeTruthy();

    const code = app.emails.lastCodeFor(email);
    expect(code).toMatch(/^\d{6}$/);

    const verified = await verify({ email, code });
    expect(verified.status).toBe(200);
    const ticket = expectData(verified, registerVerifyResponseSchema).ticket;

    const completed = await complete({ ticket, password: 'a-decent-passphrase' });
    expect(completed.status).toBe(200);
    const user = expectData(completed, userDtoSchema);
    expect(user).toMatchObject({
      email,
      displayName: 'admin',
      role: 'ADMIN',
      language: 'EN',
      theme: 'SYSTEM',
    });

    // Signed in, with the cookie attributes of docs/08 §8.2.
    const sid = cookieNamed(completed, 'sid');
    expect(sid).toBeDefined();
    expect(sid).toContain('HttpOnly');
    expect(sid).toContain('SameSite=Lax');
    expect(sid).toContain('Path=/');

    // The account exists with an Argon2id hash that never leaves the server.
    const stored = await testPrisma().user.findFirst({ where: { email } });
    expect(stored?.role).toBe('ADMIN');
    expect(stored?.passwordHash).toContain('$argon2id$');
    expect(JSON.stringify(completed.body)).not.toContain('argon2');
  });

  it('creates exactly one admin when two onboardings race', async () => {
    const tickets = await Promise.all(
      ['racer-a@legere.local', 'racer-b@legere.local'].map((email) => issueTicket(email)),
    );

    const results = await Promise.all(
      tickets.map((ticket) => complete({ ticket, password: 'a-decent-passphrase' })),
    );

    const succeeded = results.filter((res) => res.status === 200);
    const rejected = results.filter((res) => res.status !== 200);
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0];
    if (failure === undefined) throw new Error('expected one rejection');
    expect(expectError(failure).code).toBe('EMAIL_ALREADY_REGISTERED');
    expect(await testPrisma().user.count({ where: { role: 'ADMIN' } })).toBe(1);
  });

  it('burns the record after five wrong codes', async () => {
    const email = 'burn@legere.local';
    await start({ email });
    const realCode = app.emails.lastCodeFor(email);
    const wrongCode = realCode === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const res = await verify({ email, code: wrongCode });
      expect(res.status).toBe(400);
      expect(expectError(res).code).toBe('EMAIL_CODE_INVALID');
    }

    const fifth = await verify({ email, code: wrongCode });
    expect(fifth.status).toBe(429);
    expect(expectError(fifth).code).toBe('EMAIL_CODE_TOO_MANY_ATTEMPTS');

    // The series is gone: even the correct code no longer works.
    const afterBurn = await verify({ email, code: realCode });
    expect(expectError(afterBurn).code).toBe('EMAIL_CODE_INVALID');
    expect(await testPrisma().emailVerification.count({ where: { email } })).toBe(0);
  });

  // 🔒 SEC-28: the attempt counter is spent by the write, before the code is compared, so requests
  // arriving together cannot all be measured against a number none of them has moved yet.
  it('consumes one attempt per verification when several arrive at once', async () => {
    const email = 'concurrent@legere.local';
    await start({ email });
    const wrongCode = app.emails.lastCodeFor(email) === '000000' ? '111111' : '000000';

    const burst = 3;
    const results = await Promise.all(
      Array.from({ length: burst }, () => verify({ email, code: wrongCode })),
    );

    expect(results.every((res) => res.status === 400)).toBe(true);
    const series = await testPrisma().emailVerification.findFirstOrThrow({ where: { email } });
    expect(series.attempts).toBe(burst);
  });

  it('burns the series and issues no ticket when a burst of guesses arrives at once', async () => {
    const email = 'burst@legere.local';
    await start({ email });
    const realCode = app.emails.lastCodeFor(email);
    const wrongCode = realCode === '000000' ? '111111' : '000000';

    const results = await Promise.all(
      Array.from({ length: 20 }, () => verify({ email, code: wrongCode })),
    );

    // Every request is answered by the flow itself — the cap running out is not an unhandled error.
    expect(results.some((res) => res.status >= 500)).toBe(false);
    expect(results.some((res) => res.status === 200)).toBe(false);
    expect(
      results.every((res) =>
        ['EMAIL_CODE_INVALID', 'EMAIL_CODE_TOO_MANY_ATTEMPTS'].includes(expectError(res).code),
      ),
    ).toBe(true);

    // The burst did not sail past the cap: the series is gone, and the right code is worth nothing.
    expect(await testPrisma().emailVerification.count({ where: { email } })).toBe(0);
    expect(expectError(await verify({ email, code: realCode })).code).toBe('EMAIL_CODE_INVALID');
  });

  it('rejects an expired code and an expired ticket', async () => {
    const email = 'expiry@legere.local';
    await start({ email });
    const code = app.emails.lastCodeFor(email);

    await testPrisma().emailVerification.update({
      where: { email_purpose: { email, purpose: 'REGISTRATION' } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expiredCode = await verify({ email, code });
    expect(expiredCode.status).toBe(400);
    expect(expectError(expiredCode).code).toBe('EMAIL_CODE_INVALID');

    // Fresh series → a valid ticket, then expire the ticket itself.
    await testPrisma().emailVerification.deleteMany({ where: { email } });
    const ticket = await issueTicket(email);
    await testPrisma().emailVerification.update({
      where: { email_purpose: { email, purpose: 'REGISTRATION' } },
      data: { ticketExpiresAt: new Date(Date.now() - 1000) },
    });

    const expiredTicket = await complete({ ticket, password: 'a-decent-passphrase' });
    expect(expiredTicket.status).toBe(400);
    expect(expectError(expiredTicket).code).toBe('REGISTRATION_TICKET_INVALID');
  });

  it('rejects a ticket that was already used', async () => {
    const ticket = await issueTicket('reuse@legere.local');
    expect((await complete({ ticket, password: 'a-decent-passphrase' })).status).toBe(200);

    const second = await complete({ ticket, password: 'another-passphrase' });
    expect(second.status).toBe(400);
    expect(expectError(second).code).toBe('REGISTRATION_TICKET_INVALID');
  });

  it('enforces the per-email cap of one code per minute', async () => {
    const email = 'throttle@legere.local';
    expect((await start({ email })).status).toBe(200);

    const second = await start({ email });
    expect(second.status).toBe(429);
    expect(expectError(second).code).toBe('RATE_LIMITED');
    expect(app.emails.sent.filter((message) => message.to === email)).toHaveLength(1);
  });

  it('enforces the per-email daily cap of five codes', async () => {
    const email = 'daily@legere.local';
    // Backdate each series so only the daily counter can stop the flow.
    for (let sent = 1; sent <= 5; sent += 1) {
      expect((await start({ email })).status).toBe(200);
      await testPrisma().emailVerification.updateMany({
        where: { email },
        data: { createdAt: new Date(Date.now() - 10 * 60 * 1000) },
      });
    }

    const sixth = await start({ email });
    expect(sixth.status).toBe(429);
    expect(expectError(sixth).code).toBe('RATE_LIMITED');
  });

  it('answers register/start identically for a taken address (anti-enumeration)', async () => {
    await onboardFirstAdmin('taken@legere.local');
    await clearEmailSeries();

    // Once onboarding is closed an invite is required; make one so both calls take the same path.
    const inviteToken = await createInvite();
    const takenResponse = await start({ email: 'taken@legere.local', inviteToken });
    const freshResponse = await start({ email: 'fresh@legere.local', inviteToken });

    expect(takenResponse.status).toBe(freshResponse.status);
    expect(takenResponse.status).toBe(200);
    expect(Object.keys(expectData(takenResponse, registerStartResponseSchema))).toEqual(
      Object.keys(expectData(freshResponse, registerStartResponseSchema)),
    );

    // The difference lives in the letter, never in the API response.
    expect(app.emails.lastTo('taken@legere.local')?.text).toContain(
      'already have a Legere account',
    );
    expect(app.emails.lastTo('fresh@legere.local')?.text).not.toContain('already have');
  });

  it('refuses a tokenless registration once onboarding is closed', async () => {
    await onboardFirstAdmin('owner@legere.local');
    await clearEmailSeries();

    const res = await start({ email: 'stranger@legere.local' });
    expect(res.status).toBe(400);
    expect(expectError(res).code).toBe('INVITE_INVALID');
    expect(app.emails.lastTo('stranger@legere.local')).toBeUndefined();
  });

  it('rejects an unknown invite token', async () => {
    await onboardFirstAdmin('owner2@legere.local');
    await clearEmailSeries();

    const res = await start({ email: 'stranger@legere.local', inviteToken: 'x'.repeat(43) });
    expect(res.status).toBe(400);
    expect(expectError(res).code).toBe('INVITE_INVALID');
  });

  it('registers an invited user with the invite role and marks the invite accepted', async () => {
    await onboardFirstAdmin('owner3@legere.local');
    await clearEmailSeries();
    const inviteToken = await createInvite();

    const email = 'invited@legere.local';
    await start({ email, inviteToken });
    const verified = await verify({ email, code: app.emails.lastCodeFor(email), inviteToken });
    const completed = await complete({
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: 'a-decent-passphrase',
    });

    expect(completed.status).toBe(200);
    expect(expectData(completed, userDtoSchema).role).toBe('USER');
    const invite = await testPrisma().userInvite.findFirstOrThrow();
    expect(invite.acceptedAt).not.toBeNull();
  });

  // 🔒 SEC-57: knowing an address used to be enough to spend its five guesses and burn the series,
  // so the person the letter went to was refused their own correct code. §8.4.1a's rule has a
  // verification-code twin: a backoff may slow an attacker down and may never stand between an
  // account and its own password (docs/08 §8.1.3 step 2).
  it('lets the holder of an invite pass their code while a stranger burns guesses at it', async () => {
    await onboardFirstAdmin('owner4@legere.local');
    await clearEmailSeries();
    const inviteToken = await createInvite();

    const email = 'targeted@legere.local';
    await start({ email, inviteToken });
    const realCode = app.emails.lastCodeFor(email);
    const wrongCode = realCode === '000000' ? '111111' : '000000';

    // The stranger knows the address and nothing else. Nothing they send is worth an attempt.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const res = await verify({ email, code: wrongCode });
      expect(res.status).toBe(400);
      expect(expectError(res).code).toBe('EMAIL_CODE_INVALID');
    }
    const series = await testPrisma().emailVerification.findFirstOrThrow({ where: { email } });
    expect(series.attempts).toBe(0);

    // The invited user, who holds the link, still gets in with the code from their inbox.
    const verified = await verify({ email, code: realCode, inviteToken });
    expect(verified.status).toBe(200);
    expect(expectData(verified, registerVerifyResponseSchema).ticket).toBeTruthy();
  });

  // …and the cap the attempts exist to enforce still holds against the one caller who can spend it.
  it('still burns an invite series after five wrong codes from the holder', async () => {
    await onboardFirstAdmin('owner5@legere.local');
    await clearEmailSeries();
    const inviteToken = await createInvite();

    const email = 'guessed@legere.local';
    await start({ email, inviteToken });
    const realCode = app.emails.lastCodeFor(email);
    const wrongCode = realCode === '000000' ? '111111' : '000000';

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await verify({ email, code: wrongCode, inviteToken })).status).toBe(400);
    }
    const fifth = await verify({ email, code: wrongCode, inviteToken });
    expect(fifth.status).toBe(429);
    expect(expectError(fifth).code).toBe('EMAIL_CODE_TOO_MANY_ATTEMPTS');
    expect(await testPrisma().emailVerification.count({ where: { email } })).toBe(0);
  });

  it('validates the request body against the contract schema', async () => {
    const res = await start({ email: 'not-an-email' });
    expect(res.status).toBe(422);
    const error = expectError(res);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).not.toBeNull();

    const weak = await complete({ ticket: 't'.repeat(32), password: 'password' });
    expect(weak.status).toBe(422);
    expect(expectError(weak).code).toBe('VALIDATION_FAILED');
  });

  // Helpers -----------------------------------------------------------------

  async function clearEmailSeries(): Promise<void> {
    await testPrisma().emailVerification.deleteMany({});
    app.emails.reset();
  }

  // Invite creation is an admin endpoint (M2.5); the row is created directly so the invite paths of
  // register/start can be exercised now.
  async function createInvite(): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const admin = await testPrisma().user.findFirstOrThrow({ where: { role: 'ADMIN' } });
    await testPrisma().userInvite.create({
      data: {
        tokenHash: createHash('sha256').update(token).digest('hex'),
        role: 'USER',
        createdById: admin.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    return token;
  }
});
