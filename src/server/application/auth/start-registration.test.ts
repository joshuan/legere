import { beforeEach, describe, expect, it } from 'vitest';
import {
  CollectingEmailSender,
  CountingEmailSendThrottle,
  FakeSessionTokens,
  FakeVerificationCodes,
  FixedClock,
  InMemoryEmailVerificationRepository,
  InMemoryPasswordResetRepository,
  InMemoryUserInviteRepository,
  InMemoryUserRepository,
  StubCaptchaVerifier,
} from '../../../../test/helpers/fakes';
import { AuthFlowError, RateLimitedError } from '../../domain/errors/domain-error';
import { StartRegistration } from './start-registration';

function build(captcha = new StubCaptchaVerifier()) {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository(clock);
  const verifications = new InMemoryEmailVerificationRepository(clock);
  const invites = new InMemoryUserInviteRepository();
  const resets = new InMemoryPasswordResetRepository();
  const sender = new CollectingEmailSender();
  const throttle = new CountingEmailSendThrottle();
  const tokens = new FakeSessionTokens();

  const useCase = new StartRegistration(
    users,
    verifications,
    invites,
    resets,
    new FakeVerificationCodes(),
    tokens,
    sender,
    captcha,
    throttle,
    clock,
    'http://localhost:3000',
  );

  return { useCase, clock, users, verifications, invites, resets, sender, tokens };
}

describe('StartRegistration', () => {
  let context: ReturnType<typeof build>;

  beforeEach(() => {
    context = build();
  });

  it('sends a code valid for ten minutes', async () => {
    const result = await context.useCase.execute({ email: 'first@legere.local' });

    expect(context.sender.sent).toHaveLength(1);
    expect(context.sender.sent[0]?.text).toContain('123456');
    expect(new Date(result.expiresAt).getTime() - context.clock.now().getTime()).toBe(600_000);
  });

  it('rejects a failed CAPTCHA before touching any state', async () => {
    const { useCase, sender, verifications } = build(new StubCaptchaVerifier(false));

    await expect(useCase.execute({ email: 'first@legere.local' })).rejects.toMatchObject({
      code: 'CAPTCHA_FAILED',
    });
    expect(sender.sent).toHaveLength(0);
    expect(verifications.records.size).toBe(0);
  });

  it('refuses a second code within a minute and allows one after it', async () => {
    await context.useCase.execute({ email: 'first@legere.local' });

    context.clock.advance(59_000);
    await expect(context.useCase.execute({ email: 'first@legere.local' })).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    context.clock.advance(2_000);
    await expect(context.useCase.execute({ email: 'first@legere.local' })).resolves.toBeDefined();
    expect(context.sender.sent).toHaveLength(2);
  });

  it('stops at the daily cap of five codes', async () => {
    for (let sent = 0; sent < 5; sent += 1) {
      await context.useCase.execute({ email: 'first@legere.local' });
      context.clock.advance(61_000);
    }

    await expect(context.useCase.execute({ email: 'first@legere.local' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(context.sender.sent).toHaveLength(5);
  });

  it('requires an invite once the instance has a user', async () => {
    await context.users.create({
      email: 'owner@legere.local',
      passwordHash: 'hash',
      displayName: 'owner',
      role: 'ADMIN',
      language: 'EN',
    });

    await expect(
      context.useCase.execute({ email: 'stranger@legere.local' }),
    ).rejects.toBeInstanceOf(AuthFlowError);
    expect(context.sender.sent).toHaveLength(0);
  });

  it('accepts a valid invite and records it on the series', async () => {
    await context.users.create({
      email: 'owner@legere.local',
      passwordHash: 'hash',
      displayName: 'owner',
      role: 'ADMIN',
      language: 'EN',
    });
    context.invites.invites.push({
      id: 'invite-1',
      tokenHash: context.tokens.hash('invite-token'),
      role: 'USER',
      emailHint: null,
      createdById: 'user-1',
      expiresAt: new Date(context.clock.now().getTime() + 60_000),
      revokedAt: null,
      acceptedAt: null,
      acceptedById: null,
      createdAt: context.clock.now(),
    });

    await context.useCase.execute({
      email: 'invitee@legere.local',
      inviteToken: 'invite-token',
    });

    const series = await context.verifications.findActive('invitee@legere.local', 'REGISTRATION');
    expect(series?.inviteId).toBe('invite-1');
    expect(context.sender.sent).toHaveLength(1);
  });

  it('rejects an expired invite', async () => {
    await context.users.create({
      email: 'owner@legere.local',
      passwordHash: 'hash',
      displayName: 'owner',
      role: 'ADMIN',
      language: 'EN',
    });
    context.invites.invites.push({
      id: 'invite-old',
      tokenHash: context.tokens.hash('stale-token'),
      role: 'USER',
      emailHint: null,
      createdById: 'user-1',
      expiresAt: new Date(context.clock.now().getTime() - 1),
      revokedAt: null,
      acceptedAt: null,
      acceptedById: null,
      createdAt: context.clock.now(),
    });

    await expect(
      context.useCase.execute({ email: 'invitee@legere.local', inviteToken: 'stale-token' }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' });
  });

  it('tells an existing account holder they already have one, without changing the response', async () => {
    await context.users.create({
      email: 'owner@legere.local',
      passwordHash: 'hash',
      displayName: 'owner',
      role: 'ADMIN',
      language: 'EN',
    });
    context.invites.invites.push({
      id: 'invite-2',
      tokenHash: context.tokens.hash('invite-token'),
      role: 'USER',
      emailHint: null,
      createdById: 'user-1',
      expiresAt: new Date(context.clock.now().getTime() + 60_000),
      revokedAt: null,
      acceptedAt: null,
      acceptedById: null,
      createdAt: context.clock.now(),
    });

    const result = await context.useCase.execute({
      email: 'owner@legere.local',
      inviteToken: 'invite-token',
    });

    expect(Object.keys(result)).toEqual(['expiresAt']);
    expect(context.sender.sent[0]?.text).toContain('already have a Legere account');
  });
});
