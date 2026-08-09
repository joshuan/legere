import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakePasswordHasher,
  FixedClock,
  InMemorySessionRepository,
  InMemoryUserRepository,
} from '../../../../test/helpers/fakes';
import { ImmediateUnitOfWork } from '../../../../test/helpers/processing-fakes';
import { ChangePassword } from './change-password';

const PASSWORD = 'a-decent-passphrase';
const NEXT_PASSWORD = 'an-even-better-passphrase';

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function build() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository(clock);
  const sessions = new InMemorySessionRepository(clock);
  const hasher = new FakePasswordHasher();
  const useCase = new ChangePassword(users, sessions, hasher, new ImmediateUnitOfWork(), clock);

  const user = await users.create({
    email: 'user@legere.local',
    passwordHash: await hasher.hash(PASSWORD),
    displayName: 'user',
    role: 'USER',
    language: 'EN',
  });

  // Three sessions: the browser doing the rotation, and two the owner wants gone.
  const created = [];
  for (const userAgent of ['this browser', 'a phone', 'somebody else']) {
    created.push(
      await sessions.create({
        tokenHash: `hash-${userAgent}`,
        userId: user.id,
        userAgent,
        expiresAt: new Date(clock.now().getTime() + TTL_MS),
      }),
    );
  }

  return { useCase, users, sessions, hasher, clock, user, current: created[0] };
}

// An authenticated password rotation (docs/08 §8.1.6a).
describe('ChangePassword', () => {
  let context: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    context = await build();
  });

  it('writes the new password when the current one is presented', async () => {
    await context.useCase.execute({
      userId: context.user.id,
      currentSessionId: context.current?.id ?? '',
      currentPassword: PASSWORD,
      newPassword: NEXT_PASSWORD,
    });

    const stored = await context.users.findById(context.user.id);
    expect(await context.hasher.verify(stored?.passwordHash ?? '', NEXT_PASSWORD)).toBe(true);
    expect(await context.hasher.verify(stored?.passwordHash ?? '', PASSWORD)).toBe(false);
  });

  it('ends every other session and keeps the one making the request', async () => {
    const result = await context.useCase.execute({
      userId: context.user.id,
      currentSessionId: context.current?.id ?? '',
      currentPassword: PASSWORD,
      newPassword: NEXT_PASSWORD,
    });

    expect(result).toEqual({ revoked: 2 });
    const alive = await context.sessions.listActiveForUser(context.user.id, context.clock.now());
    expect(alive.map((session) => session.id)).toEqual([context.current?.id]);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    await expect(
      context.useCase.execute({
        userId: context.user.id,
        currentSessionId: context.current?.id ?? '',
        currentPassword: 'not-the-password',
        newPassword: NEXT_PASSWORD,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', httpStatus: 401 });

    const stored = await context.users.findById(context.user.id);
    expect(await context.hasher.verify(stored?.passwordHash ?? '', PASSWORD)).toBe(true);
    const alive = await context.sessions.listActiveForUser(context.user.id, context.clock.now());
    expect(alive).toHaveLength(3);
  });
});
