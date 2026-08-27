import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeSessionTokens,
  FakeVerificationCodes,
  FixedClock,
  InMemoryEmailVerificationRepository,
  InMemoryPasswordResetRepository,
  InMemoryUserInviteRepository,
} from '../../../../test/helpers/fakes';
import { MAX_CODE_ATTEMPTS } from '../../domain/entities/email-verification';
import { VerifyEmailCode } from './verify-email-code';

const EMAIL = 'user@legere.local';
// FakeSessionTokens hashes by prefixing, so this is the token whose hash the link rows carry.
const INVITE_TOKEN = 'the-invite-token';
const RESET_TOKEN = 'the-reset-token';

// Counts how many codes were actually put to the test, which is the number the attempt cap is
// supposed to bound (docs/08 §8.1.3 step 2).
class CountingVerificationCodes extends FakeVerificationCodes {
  comparisons = 0;
  override matches(hash: string, code: string): boolean {
    this.comparisons += 1;
    return super.matches(hash, code);
  }
}

function build() {
  const clock = new FixedClock();
  const verifications = new InMemoryEmailVerificationRepository(clock);
  const invites = new InMemoryUserInviteRepository();
  const resets = new InMemoryPasswordResetRepository();
  const codes = new CountingVerificationCodes();
  const useCase = new VerifyEmailCode(
    verifications,
    invites,
    resets,
    codes,
    new FakeSessionTokens(),
    clock,
  );
  return { useCase, clock, verifications, invites, resets, codes };
}

// The onboarding series: started with no link, so there is none to hold (docs/08 §8.1.3 step 2).
async function seedSeries(context: ReturnType<typeof build>): Promise<void> {
  await context.verifications.replace({
    email: EMAIL,
    purpose: 'REGISTRATION',
    codeHash: 'code:123456',
    expiresAt: new Date(context.clock.now().getTime() + 600_000),
    inviteId: null,
    passwordResetId: null,
  });
}

// A reset series and the link it was made from, the way StartRegistration leaves them.
async function seedResetSeries(context: ReturnType<typeof build>): Promise<void> {
  const reset = await context.resets.create({
    userId: 'user-1',
    tokenHash: `hash:${RESET_TOKEN}`,
    createdById: 'admin-1',
    expiresAt: new Date(context.clock.now().getTime() + 86_400_000),
  });
  await context.verifications.replace({
    email: EMAIL,
    purpose: 'PASSWORD_RESET',
    codeHash: 'code:123456',
    expiresAt: new Date(context.clock.now().getTime() + 600_000),
    inviteId: null,
    passwordResetId: reset.id,
  });
}

async function seedInviteSeries(context: ReturnType<typeof build>): Promise<void> {
  const invite = await context.invites.create({
    tokenHash: `hash:${INVITE_TOKEN}`,
    role: 'USER',
    emailHint: null,
    createdById: 'admin-1',
    expiresAt: new Date(context.clock.now().getTime() + 86_400_000),
  });
  await context.verifications.replace({
    email: EMAIL,
    purpose: 'REGISTRATION',
    codeHash: 'code:123456',
    expiresAt: new Date(context.clock.now().getTime() + 600_000),
    inviteId: invite.id,
    passwordResetId: null,
  });
}

describe('VerifyEmailCode', () => {
  let context: ReturnType<typeof build>;

  beforeEach(async () => {
    context = build();
    await seedSeries(context);
  });

  it('issues a ticket valid for fifteen minutes on the right code', async () => {
    const result = await context.useCase.execute({ email: EMAIL, code: '123456' });

    expect(result.ticket).toBeTruthy();
    expect(new Date(result.expiresAt).getTime() - context.clock.now().getTime()).toBe(900_000);

    const series = await context.verifications.findActive(EMAIL, 'REGISTRATION');
    expect(series?.verifiedAt).not.toBeNull();
    expect(series?.ticketHash).toBe(`hash:${result.ticket}`);
  });

  it('counts wrong codes and burns the series on the fifth', async () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(context.useCase.execute({ email: EMAIL, code: '000000' })).rejects.toMatchObject(
        {
          code: 'EMAIL_CODE_INVALID',
        },
      );
    }
    expect((await context.verifications.findActive(EMAIL, 'REGISTRATION'))?.attempts).toBe(4);

    await expect(context.useCase.execute({ email: EMAIL, code: '000000' })).rejects.toMatchObject({
      code: 'EMAIL_CODE_TOO_MANY_ATTEMPTS',
    });
    expect(await context.verifications.findActive(EMAIL, 'REGISTRATION')).toBeNull();
  });

  it('spends one attempt per verification when several arrive at once', async () => {
    const burst = 3;
    const results = await Promise.allSettled(
      Array.from({ length: burst }, () =>
        context.useCase.execute({ email: EMAIL, code: '000000' }),
      ),
    );

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect((await context.verifications.findActive(EMAIL, 'REGISTRATION'))?.attempts).toBe(burst);
    expect(context.codes.comparisons).toBe(burst);
  });

  it('tests no more codes than the cap allows when a burst arrives at once', async () => {
    const burst = MAX_CODE_ATTEMPTS * 4;
    const results = await Promise.allSettled(
      Array.from({ length: burst }, () =>
        context.useCase.execute({ email: EMAIL, code: '000000' }),
      ),
    );

    // The counter is the gate, so the guesses beyond the cap never reach the comparison at all.
    expect(context.codes.comparisons).toBeLessThanOrEqual(MAX_CODE_ATTEMPTS);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(await context.verifications.findActive(EMAIL, 'REGISTRATION')).toBeNull();
  });

  it('rejects an expired code', async () => {
    context.clock.advance(600_001);

    await expect(context.useCase.execute({ email: EMAIL, code: '123456' })).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });
  });

  it('rejects a code for an address with no series, revealing nothing', async () => {
    await expect(
      context.useCase.execute({ email: 'nobody@legere.local', code: '123456' }),
    ).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });
  });

  it('refuses to reuse a consumed series', async () => {
    const series = await context.verifications.findActive(EMAIL, 'REGISTRATION');
    if (series === null) throw new Error('missing series');
    await context.verifications.markConsumed(series.id, context.clock.now());

    await expect(context.useCase.execute({ email: EMAIL, code: '123456' })).rejects.toMatchObject({
      code: 'EMAIL_CODE_INVALID',
    });
  });

  // 🔒 SEC-57: an attempt is charged only to a caller who proves they hold the link the series was
  // made from, so a backoff meant for a guesser never stands between an account and its own
  // password (docs/08 §8.1.3 step 2, §8.4.1a).
  describe('proof that the caller holds the link (SEC-57)', () => {
    // Without the onboarding series of the outer setup, which is the one case with no link to hold
    // and would otherwise stand in for every series these tests are about.
    beforeEach(() => {
      context = build();
    });

    it('lets the holder of a reset link spend and pass its code', async () => {
      await seedResetSeries(context);

      const result = await context.useCase.execute({
        email: EMAIL,
        code: '123456',
        resetToken: RESET_TOKEN,
      });

      expect(result.ticket).toBeTruthy();
    });

    it('charges a stranger nothing, however many codes they try', async () => {
      await seedResetSeries(context);

      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS * 3; attempt += 1) {
        await expect(
          context.useCase.execute({ email: EMAIL, code: '000000' }),
        ).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });
      }

      // Not one guess was tested and not one attempt was spent, so the series is still here…
      expect(context.codes.comparisons).toBe(0);
      expect((await context.verifications.findActive(EMAIL, 'PASSWORD_RESET'))?.attempts).toBe(0);
      // …and the correct code from the person the letter went to still works.
      const held = await context.useCase.execute({
        email: EMAIL,
        code: '123456',
        resetToken: RESET_TOKEN,
      });
      expect(held.ticket).toBeTruthy();
    });

    it('is not satisfied by some other link of the same kind', async () => {
      await seedResetSeries(context);
      await context.resets.create({
        userId: 'user-2',
        tokenHash: 'hash:somebody-elses-link',
        createdById: 'admin-1',
        expiresAt: new Date(context.clock.now().getTime() + 86_400_000),
      });

      await expect(
        context.useCase.execute({
          email: EMAIL,
          code: '123456',
          resetToken: 'somebody-elses-link',
        }),
      ).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });
      expect(context.codes.comparisons).toBe(0);
    });

    it('still burns the series after five wrong codes from the holder', async () => {
      await seedInviteSeries(context);

      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS - 1; attempt += 1) {
        await expect(
          context.useCase.execute({ email: EMAIL, code: '000000', inviteToken: INVITE_TOKEN }),
        ).rejects.toMatchObject({ code: 'EMAIL_CODE_INVALID' });
      }
      await expect(
        context.useCase.execute({ email: EMAIL, code: '000000', inviteToken: INVITE_TOKEN }),
      ).rejects.toMatchObject({ code: 'EMAIL_CODE_TOO_MANY_ATTEMPTS' });

      expect(await context.verifications.findActive(EMAIL, 'REGISTRATION')).toBeNull();
    });

    // The reset is tried first (SEC-19), but a caller holding only the invite is measured against
    // the series that is actually theirs rather than refused for the one that is not.
    it('falls through to the series the caller can prove, not the one that sorts first', async () => {
      await seedResetSeries(context);
      await seedInviteSeries(context);

      const result = await context.useCase.execute({
        email: EMAIL,
        code: '123456',
        inviteToken: INVITE_TOKEN,
      });

      expect(result.ticket).toBeTruthy();
      expect((await context.verifications.findActive(EMAIL, 'PASSWORD_RESET'))?.attempts).toBe(0);
    });
  });
});
