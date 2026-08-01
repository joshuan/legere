import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeSessionTokens,
  FixedClock,
  InMemoryUserRepository,
  StubCaptchaVerifier,
} from '../../../../test/helpers/fakes';
import { Argon2PasswordHasher } from '../../infrastructure/auth/argon2-password-hasher';
import { InMemoryLoginAttempts } from '../../infrastructure/auth/in-memory-login-attempts';
import { SessionRepository } from '../../domain/repositories/session.repository';
import type { Session } from '../../domain/entities/session';
import type { CreateSessionInput } from '../../domain/repositories/session.repository';
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

class InMemorySessionRepository extends SessionRepository {
  readonly sessions: Session[] = [];
  private counter = 0;

  constructor(private readonly clock: FixedClock) {
    super();
  }

  create(input: CreateSessionInput): Promise<Session> {
    this.counter += 1;
    const session: Session = {
      id: `session-${this.counter}`,
      tokenHash: input.tokenHash,
      userId: input.userId,
      userAgent: input.userAgent,
      createdAt: this.clock.now(),
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.push(session);
    return Promise.resolve(session);
  }

  findByTokenHash(tokenHash: string): Promise<Session | null> {
    return Promise.resolve(this.sessions.find((s) => s.tokenHash === tokenHash) ?? null);
  }

  revoke(id: string, revokedAt: Date): Promise<void> {
    const session = this.sessions.find((s) => s.id === id);
    if (session !== undefined) session.revokedAt = revokedAt;
    return Promise.resolve();
  }

  revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    let revoked = 0;
    for (const session of this.sessions) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = revokedAt;
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
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

  it('applies an exponential backoff after five failures and clears it on success', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(
        context.useCase.execute({
          email: 'user@legere.local',
          password: 'not-the-password',
          userAgent: null,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }

    await expect(
      context.useCase.execute({ email: 'user@legere.local', password: PASSWORD, userAgent: null }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    // The window passes and the right password works again, which resets the streak.
    context.clock.advance(1_001);
    await expect(
      context.useCase.execute({ email: 'user@legere.local', password: PASSWORD, userAgent: null }),
    ).resolves.toBeDefined();
    expect(context.attempts.retryAfterMs('user@legere.local')).toBe(0);
  });
});
