import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeSessionTokens,
  FixedClock,
  InMemorySessionRepository,
  InMemoryUserRepository,
  StubCaptchaVerifier,
} from '../../../../test/helpers/fakes';
import { Argon2PasswordHasher } from '../../infrastructure/auth/argon2-password-hasher';
import { InMemoryLoginAttempts } from '../../infrastructure/auth/in-memory-login-attempts';
import { IssueSession } from './issue-session';
import { Login } from './login';

const PASSWORD = 'a-decent-passphrase';

// Counts verifications so a test can prove the unknown-address path still pays for one (docs/08
// §8.1.5): without it, a missing account would answer measurably faster than a wrong password.
class CountingPasswordHasher extends Argon2PasswordHasher {
  readonly verified: string[] = [];

  override verify(hash: string, password: string): Promise<boolean> {
    this.verified.push(hash);
    return super.verify(hash, password);
  }
}

async function build(captcha = new StubCaptchaVerifier()) {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository(clock);
  const sessions = new InMemorySessionRepository(clock);
  const hasher = new CountingPasswordHasher();
  const attempts = new InMemoryLoginAttempts(clock);
  const issueSession = new IssueSession(sessions, new FakeSessionTokens(), clock, 30);
  const useCase = new Login(users, hasher, captcha, attempts, issueSession);

  await users.create({
    email: 'user@legere.local',
    passwordHash: await hasher.hash(PASSWORD),
    displayName: 'user',
    role: 'USER',
    language: 'EN',
  });

  return { useCase, clock, users, sessions, attempts, hasher };
}

describe('Login', () => {
  let context: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    context = await build();
  });

  it('issues a session for the right password', async () => {
    const result = await context.useCase.execute({
      email: 'user@legere.local',
      password: PASSWORD,
      userAgent: 'vitest',
    });

    expect(result.user.email).toBe('user@legere.local');
    expect(context.sessions.sessions).toHaveLength(1);
    expect(context.sessions.sessions[0]?.userAgent).toBe('vitest');
    // TTL is SESSION_TTL_DAYS from the moment of login (docs/08 §8.2).
    const expiresAt = context.sessions.sessions[0]?.expiresAt.getTime() ?? 0;
    expect(expiresAt - context.clock.now().getTime()).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('creates a new session per login rather than reusing one', async () => {
    await context.useCase.execute({
      email: 'user@legere.local',
      password: PASSWORD,
      userAgent: null,
    });
    await context.useCase.execute({
      email: 'user@legere.local',
      password: PASSWORD,
      userAgent: null,
    });

    expect(context.sessions.sessions).toHaveLength(2);
    const hashes = context.sessions.sessions.map((session) => session.tokenHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it('reports the same error for an unknown address and a wrong password', async () => {
    const unknown = await context.useCase
      .execute({ email: 'nobody@legere.local', password: PASSWORD, userAgent: null })
      .catch((error: unknown) => error);
    const wrong = await context.useCase
      .execute({ email: 'user@legere.local', password: 'not-the-password', userAgent: null })
      .catch((error: unknown) => error);

    expect(unknown).toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });
    expect(wrong).toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });
    expect(context.sessions.sessions).toHaveLength(0);
  });

  it('verifies a hash even for an address nobody registered, so both answers cost the same', async () => {
    const known = await context.users.findActiveByEmail('user@legere.local');
    context.hasher.verified.length = 0;

    await context.useCase
      .execute({ email: 'nobody@legere.local', password: PASSWORD, userAgent: null })
      .catch(() => undefined);

    // 🔒 One verification either way, against a hash that is not any user's (docs/08 §8.1.5).
    expect(context.hasher.verified).toHaveLength(1);
    expect(context.hasher.verified[0]).not.toBe(known?.passwordHash);
  });

  it('refuses a deactivated account that presents the right password', async () => {
    const user = await context.users.findActiveByEmail('user@legere.local');
    if (user === null) throw new Error('missing user');
    await context.users.update(user.id, { deactivatedAt: context.clock.now() });

    await expect(
      context.useCase.execute({ email: 'user@legere.local', password: PASSWORD, userAgent: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });
    expect(context.sessions.sessions).toHaveLength(0);
  });

  it('rejects a failed CAPTCHA before checking the password', async () => {
    const blocked = await build(new StubCaptchaVerifier(false));

    await expect(
      blocked.useCase.execute({ email: 'user@legere.local', password: PASSWORD, userAgent: null }),
    ).rejects.toMatchObject({ code: 'CAPTCHA_FAILED' });
  });

  it('applies an exponential backoff to repeated failures against one address', async () => {
    const wrong = () =>
      context.useCase.execute({
        email: 'user@legere.local',
        password: 'not-the-password',
        userAgent: null,
      });

    // The first four are plain refusals; the fifth is where the window opens (docs/08 §8.4).
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(wrong()).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    await expect(wrong()).rejects.toMatchObject({ code: 'RATE_LIMITED', httpStatus: 429 });

    // And it grows: a failure inside the window doubles the wait for the next one.
    context.clock.advance(1_001);
    await expect(wrong()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(context.attempts.retryAfterMs('user@legere.local')).toBe(2_000);
  });

  it('signs the owner in mid-backoff, because the password is checked before the streak', async () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await context.useCase
        .execute({ email: 'user@legere.local', password: 'not-the-password', userAgent: null })
        .catch(() => undefined);
    }
    // 🔒 The streak is deep enough to be a lockout under the old order (docs/08 §8.4, SEC-12).
    expect(context.attempts.retryAfterMs('user@legere.local')).toBeGreaterThan(0);

    await expect(
      context.useCase.execute({ email: 'user@legere.local', password: PASSWORD, userAgent: null }),
    ).resolves.toMatchObject({ user: { email: 'user@legere.local' } });

    // Success clears it whatever it said, so the next wrong guess starts from zero again.
    expect(context.attempts.retryAfterMs('user@legere.local')).toBe(0);
  });

  it('backs an unknown address off exactly as it backs off one that exists', async () => {
    const fail = (email: string) =>
      context.useCase
        .execute({ email, password: 'not-the-password', userAgent: null })
        .catch((error: unknown) => error);

    const known = [];
    const unknown = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      known.push(await fail('user@legere.local'));
      unknown.push(await fail('nobody@legere.local'));
    }

    // 🔒 Failure for failure the two addresses answer the same thing, so the streak cannot be used
    // to ask whether an account exists (docs/08 §8.1.4).
    expect(unknown.map(codeOf)).toEqual(known.map(codeOf));
    expect(codeOf(known[4])).toBe('RATE_LIMITED');
  });

  it('spends one verification per attempt whether or not the address is in backoff', async () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await context.useCase
        .execute({ email: 'user@legere.local', password: 'not-the-password', userAgent: null })
        .catch(() => undefined);
    }
    context.hasher.verified.length = 0;

    // Refused as a rate limit, and still paid for: nothing answers before the hash is computed, so
    // a fast 429 and a slow 401 can never be told apart by a clock (docs/08 §8.1.4, §8.4).
    await context.useCase
      .execute({ email: 'user@legere.local', password: 'not-the-password', userAgent: null })
      .catch(() => undefined);
    await context.useCase
      .execute({ email: 'nobody@legere.local', password: 'not-the-password', userAgent: null })
      .catch(() => undefined);

    expect(context.hasher.verified).toHaveLength(2);
  });
});

function codeOf(error: unknown): unknown {
  return error instanceof Object && 'code' in error ? error.code : error;
}
