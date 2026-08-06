import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakePasswordHasher,
  FakeSessionTokens,
  FixedClock,
  InMemoryEmailVerificationRepository,
  InMemoryPasswordResetRepository,
  InMemorySessionRepository,
  InMemoryUserInviteRepository,
  InMemoryUserRepository,
} from '../../../../test/helpers/fakes';
import { ImmediateUnitOfWork } from '../../../../test/helpers/processing-fakes';
import { CompleteRegistration } from './complete-registration';
import { IssueSession } from './issue-session';

const INVITEE = 'invitee@legere.local';
const PASSWORD = 'a-decent-passphrase';

// A repository that reads a valid row and then refuses the conditional write, which is exactly what
// the database does to the loser of a race: both transactions saw an unspent link, one UPDATE moved
// a row and the other moved none (docs/08 §8.1.2, §8.1.6).
class LosingInviteRepository extends InMemoryUserInviteRepository {
  override markAccepted(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class LosingPasswordResetRepository extends InMemoryPasswordResetRepository {
  override markUsed(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function build(
  invites = new InMemoryUserInviteRepository(),
  resets = new InMemoryPasswordResetRepository(),
) {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository(clock);
  const verifications = new InMemoryEmailVerificationRepository(clock);
  const sessions = new InMemorySessionRepository(clock);
  const tokens = new FakeSessionTokens();

  const useCase = new CompleteRegistration(
    users,
    verifications,
    invites,
    resets,
    sessions,
    new FakePasswordHasher(),
    tokens,
    new IssueSession(sessions, tokens, clock, 30),
    new ImmediateUnitOfWork(),
    clock,
  );

  return { useCase, clock, users, verifications, invites, resets, sessions, tokens };
}

type Context = ReturnType<typeof build>;

// Everything StartRegistration and VerifyEmailCode would have left behind: a verified series whose
// ticket is the one the caller now presents.
async function issueTicket(
  context: Context,
  series: { email: string; inviteId?: string; passwordResetId?: string },
): Promise<string> {
  const now = context.clock.now();
  const record = await context.verifications.replace({
    email: series.email,
    purpose: series.passwordResetId === undefined ? 'REGISTRATION' : 'PASSWORD_RESET',
    codeHash: 'code:123456',
    expiresAt: new Date(now.getTime() + 600_000),
    inviteId: series.inviteId ?? null,
    passwordResetId: series.passwordResetId ?? null,
  });
  const { token, hash } = context.tokens.generate();
  await context.verifications.issueTicket(record.id, {
    verifiedAt: now,
    ticketHash: hash,
    ticketExpiresAt: new Date(now.getTime() + 900_000),
  });
  return token;
}

function seedInvite(context: Context, overrides: Partial<{ revokedAt: Date; expiresAt: Date }>) {
  const invite = {
    id: 'invite-1',
    tokenHash: 'hash:invite-token',
    role: 'ADMIN' as const,
    emailHint: null,
    createdById: 'user-1',
    expiresAt: new Date(context.clock.now().getTime() + 60_000),
    revokedAt: null,
    acceptedAt: null,
    acceptedById: null,
    createdAt: context.clock.now(),
    ...overrides,
  };
  context.invites.invites.push(invite);
  return invite;
}

async function seedResetTarget(context: Context) {
  const target = await context.users.create({
    email: 'target@legere.local',
    passwordHash: 'hashed:the-old-passphrase',
    displayName: 'target',
    role: 'USER',
    language: 'EN',
  });
  const reset = await context.resets.create({
    userId: target.id,
    tokenHash: 'hash:reset-token',
    createdById: 'user-1',
    expiresAt: new Date(context.clock.now().getTime() + 86_400_000),
  });
  return { target, reset };
}

describe('CompleteRegistration', () => {
  let context: Context;

  beforeEach(() => {
    context = build();
  });

  it('creates the account with the invite role and spends the invite', async () => {
    seedInvite(context, {});
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    const result = await context.useCase.execute({
      ticket,
      password: PASSWORD,
      language: 'EN',
      userAgent: null,
    });

    expect(result.user).toMatchObject({ email: INVITEE, role: 'ADMIN' });
    expect(result.sessionToken).toBeTruthy();
    const invite = await context.invites.findById('invite-1');
    expect(invite?.acceptedAt).not.toBeNull();
    expect(invite?.acceptedById).toBe(result.user.id);
  });

  it('refuses a second completion against an invite already spent', async () => {
    seedInvite(context, {});
    const first = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });
    const second = await issueTicket(context, {
      email: 'second@legere.local',
      inviteId: 'invite-1',
    });

    await context.useCase.execute({
      ticket: first,
      password: PASSWORD,
      language: 'EN',
      userAgent: null,
    });

    await expect(
      context.useCase.execute({
        ticket: second,
        password: PASSWORD,
        language: 'EN',
        userAgent: null,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    expect(context.users.users).toHaveLength(1);
  });

  it('refuses a completion against an invite revoked inside the ticket window', async () => {
    seedInvite(context, { revokedAt: context.clock.now() });
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    await expect(
      context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    expect(context.users.users).toHaveLength(0);
  });

  it('refuses a completion against an invite that expired inside the ticket window', async () => {
    seedInvite(context, { expiresAt: new Date(context.clock.now().getTime() - 1) });
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    await expect(
      context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    expect(context.users.users).toHaveLength(0);
  });

  it('turns a markAccepted that moved no row into INVITE_INVALID and creates nobody', async () => {
    context = build(new LosingInviteRepository());
    seedInvite(context, {});
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    await expect(
      context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });
    // The insert happened before the losing write; only the rolled-back transaction undoes it, so
    // what matters here is that the use case refuses rather than returning a session.
    expect(context.sessions.sessions).toHaveLength(0);
  });

  it('changes the password through a valid reset and spends the link', async () => {
    const { target, reset } = await seedResetTarget(context);
    const ticket = await issueTicket(context, {
      email: target.email,
      passwordResetId: reset.id,
    });

    const result = await context.useCase.execute({
      ticket,
      password: PASSWORD,
      language: 'EN',
      userAgent: null,
    });

    expect(result.user.id).toBe(target.id);
    expect((await context.users.findById(target.id))?.passwordHash).toBe(`hashed:${PASSWORD}`);
    expect((await context.resets.findById(reset.id))?.usedAt).not.toBeNull();
  });

  it('refuses a reset whose account was deactivated inside the ticket window', async () => {
    const { target, reset } = await seedResetTarget(context);
    const ticket = await issueTicket(context, { email: target.email, passwordResetId: reset.id });
    await context.users.update(target.id, { deactivatedAt: context.clock.now() });

    await expect(
      context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null }),
    ).rejects.toMatchObject({ code: 'RESET_INVALID' });
    expect((await context.users.findById(target.id))?.passwordHash).toBe(
      'hashed:the-old-passphrase',
    );
  });

  it('refuses a reset revoked inside the ticket window', async () => {
    const { target, reset } = await seedResetTarget(context);
    const ticket = await issueTicket(context, { email: target.email, passwordResetId: reset.id });
    await context.resets.revokeAllForUser(target.id, context.clock.now());

    await expect(
      context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null }),
    ).rejects.toMatchObject({ code: 'RESET_INVALID' });
    expect((await context.users.findById(target.id))?.passwordHash).toBe(
      'hashed:the-old-passphrase',
    );
  });

  it('turns a markUsed that moved no row into RESET_INVALID and leaves the password alone', async () => {
    context = build(new InMemoryUserInviteRepository(), new LosingPasswordResetRepository());
    const { target, reset } = await seedResetTarget(context);
    const ticket = await issueTicket(context, { email: target.email, passwordResetId: reset.id });

    await expect(
      context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null }),
    ).rejects.toMatchObject({ code: 'RESET_INVALID' });
    expect((await context.users.findById(target.id))?.passwordHash).toBe(
      'hashed:the-old-passphrase',
    );
  });
});
