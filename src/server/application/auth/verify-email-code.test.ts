import { beforeEach, describe, expect, it } from 'vitest';
import {
  FakeSessionTokens,
  FakeVerificationCodes,
  FixedClock,
  InMemoryEmailVerificationRepository,
} from '../../../../test/helpers/fakes';
import { MAX_CODE_ATTEMPTS } from '../../domain/entities/email-verification';
import { VerifyEmailCode } from './verify-email-code';

const EMAIL = 'user@legere.local';

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
  const codes = new CountingVerificationCodes();
  const useCase = new VerifyEmailCode(verifications, codes, new FakeSessionTokens(), clock);
  return { useCase, clock, verifications, codes };
}

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
});
