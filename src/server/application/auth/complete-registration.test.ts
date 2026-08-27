import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakePasswordHasher,
  FakeSessionTokens,
  FixedClock,
  InMemoryApiTokenRepository,
  InMemoryEmailVerificationRepository,
  InMemoryPasswordResetRepository,
  InMemorySessionRepository,
  InMemoryUserInviteRepository,
  InMemoryUserRepository,
  RecordingSecurityEvents,
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
  const apiTokens = new InMemoryApiTokenRepository(clock);
  const tokens = new FakeSessionTokens();
  const events = new RecordingSecurityEvents();

  const useCase = new CompleteRegistration(
    users,
    verifications,
    invites,
    resets,
    sessions,
    apiTokens,
    new FakePasswordHasher(),
    tokens,
    new IssueSession(sessions, tokens, clock, 30),
    new ImmediateUnitOfWork(),
    clock,
    events,
  );

  return {
    useCase,
    clock,
    users,
    verifications,
    invites,
    resets,
    sessions,
    apiTokens,
    tokens,
    events,
  };
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

  // 🔒 SEC-34 (docs/06 §6.7). The three ways this endpoint ends are three different facts about an
  // account, and each is written down once — after the commit, so a refused completion writes none.
  it('records an accepted invite with the role it granted, and never the ticket', async () => {
    seedInvite(context, {});
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    const result = await context.useCase.execute({
      ticket,
      password: PASSWORD,
      language: 'EN',
      userAgent: null,
    });

    const record = context.events.only('invite.accepted');
    expect(record).toEqual({
      event: 'invite.accepted',
      actor: { userId: result.user.id },
      target: { userId: result.user.id, id: 'invite-1' },
      detail: { role: 'ADMIN' },
    });
    expect(JSON.stringify(record)).not.toContain(ticket);
    expect(JSON.stringify(record)).not.toContain(PASSWORD);
  });

  it('records the first administrator as an account created rather than an invite', async () => {
    const ticket = await issueTicket(context, { email: INVITEE });

    const result = await context.useCase.execute({
      ticket,
      password: PASSWORD,
      language: 'EN',
      userAgent: null,
    });

    expect(context.events.only('account.created')).toEqual({
      event: 'account.created',
      actor: { userId: result.user.id },
      target: { userId: result.user.id },
      detail: { role: 'ADMIN' },
    });
  });

  it('records a completed reset with the sessions it ended, and never the ticket', async () => {
    const { target, reset } = await seedResetTarget(context);
    await context.sessions.create({
      tokenHash: 'hash:an-old-browser',
      userId: target.id,
      userAgent: 'an old browser',
      expiresAt: new Date(context.clock.now().getTime() + 86_400_000),
    });
    const ticket = await issueTicket(context, { email: target.email, passwordResetId: reset.id });

    await context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null });

    const record = context.events.only('password_reset.completed');
    expect(record).toEqual({
      event: 'password_reset.completed',
      actor: { userId: target.id },
      target: { userId: target.id, id: reset.id },
      detail: { sessions: 1, apiTokens: 0 },
    });
    expect(JSON.stringify(record)).not.toContain(ticket);
  });

  // 🔒 SEC-65: the one remediation the product offers has to remediate. A stranger who held a
  // session long enough to mint a read-only token used to keep reading the archive for a year after
  // the admin's reset had ended every session and changed the password (docs/08 §8.1.6).
  it('revokes the API tokens of a reset account along with its sessions', async () => {
    const { target, reset } = await seedResetTarget(context);
    const minted = await context.apiTokens.create({
      userId: target.id,
      name: 'sync',
      tokenHash: 'hash:legere_stolen',
      expiresAt: new Date(context.clock.now().getTime() + 365 * 86_400_000),
    });
    const ticket = await issueTicket(context, { email: target.email, passwordResetId: reset.id });

    await context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null });

    expect((await context.apiTokens.findById(minted.id))?.revokedAt).not.toBeNull();
    expect(context.events.only('password_reset.completed')).toMatchObject({
      detail: { apiTokens: 1 },
    });
  });

  // …and the self-service rotation of §8.1.6a keeps them, which is the asymmetry §8.2a records: a
  // person tidying up does not lose their backup script. A registration is not a recovery either.
  it('leaves the tokens of an unrelated account alone when an invite is accepted', async () => {
    const other = await context.users.create({
      email: 'other@legere.local',
      passwordHash: 'hashed:whatever',
      displayName: 'other',
      role: 'USER',
      language: 'EN',
    });
    const kept = await context.apiTokens.create({
      userId: other.id,
      name: 'backup',
      tokenHash: 'hash:legere_backup',
      expiresAt: new Date(context.clock.now().getTime() + 86_400_000),
    });
    seedInvite(context, {});
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    await context.useCase.execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null });

    expect((await context.apiTokens.findById(kept.id))?.revokedAt).toBeNull();
  });

  it('records nothing when the completion is refused', async () => {
    seedInvite(context, { revokedAt: context.clock.now() });
    const ticket = await issueTicket(context, { email: INVITEE, inviteId: 'invite-1' });

    await context.useCase
      .execute({ ticket, password: PASSWORD, language: 'EN', userAgent: null })
      .catch(() => undefined);

    expect(context.events.records).toEqual([]);
  });
});
