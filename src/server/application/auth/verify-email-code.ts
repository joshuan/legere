import type { RegisterVerifyResponse } from '../../../shared/contracts/auth';
import {
  isCodeUsable,
  MAX_CODE_ATTEMPTS,
  type VerificationPurpose,
} from '../../domain/entities/email-verification';
import { AuthFlowError, RateLimitedError } from '../../domain/errors/domain-error';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';
import type { VerificationCodes } from '../ports/verification-codes';

export type VerifyEmailCodeInput = {
  email: string;
  code: string;
};

// The ticket handed to step 3 is single-use and short-lived (docs/03 §3.3.3).
const TICKET_TTL_MS = 15 * 60 * 1000;

// POST /api/auth/register/verify (docs/08 §8.1.3 step 2). A correct code exchanges the series for a
// registration ticket; five wrong ones burn the record entirely, so guessing a six-digit code costs
// a fresh email round-trip every five tries.
export class VerifyEmailCode {
  constructor(
    private readonly verifications: EmailVerificationRepository,
    private readonly codes: VerificationCodes,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(input: VerifyEmailCodeInput): Promise<RegisterVerifyResponse> {
    const now = this.clock.now();
    const verification = await this.findUsableSeries(input.email, now);

    // The guess is paid for before it is made. Comparing first and incrementing after would let N
    // simultaneous requests all be measured against a counter none of them had moved yet, so a
    // connection pool's worth of codes would be tested where five should be; here the write is the
    // gate, and N concurrent verifications consume N attempts.
    const attempts = await this.verifications.consumeAttempt(verification.id, MAX_CODE_ATTEMPTS);
    if (attempts === null) {
      await this.verifications.delete(verification.id);
      throw new RateLimitedError(
        'EMAIL_CODE_TOO_MANY_ATTEMPTS',
        'Too many wrong codes; request a new one',
      );
    }

    if (!this.codes.matches(verification.codeHash, input.code)) {
      if (attempts >= MAX_CODE_ATTEMPTS) {
        await this.verifications.delete(verification.id);
        throw new RateLimitedError(
          'EMAIL_CODE_TOO_MANY_ATTEMPTS',
          'Too many wrong codes; request a new one',
        );
      }
      throw new AuthFlowError('EMAIL_CODE_INVALID', 'The code is not correct');
    }

    const { token, hash } = this.tokens.generate();
    const ticketExpiresAt = new Date(now.getTime() + TICKET_TTL_MS);
    await this.verifications.issueTicket(verification.id, {
      verifiedAt: now,
      ticketHash: hash,
      ticketExpiresAt,
    });

    return { ticket: token, expiresAt: ticketExpiresAt.toISOString() };
  }

  // Both purposes share the endpoint; the series that exists for this address decides which flow
  // the caller is in. A missing or expired series reads as an invalid code — the caller learns
  // nothing about which of the two it was.
  private async findUsableSeries(email: string, now: Date) {
    const purposes: VerificationPurpose[] = ['REGISTRATION', 'PASSWORD_RESET'];
    for (const purpose of purposes) {
      const found = await this.verifications.findActive(email, purpose);
      if (found !== null && isCodeUsable(found, now)) return found;
    }
    throw new AuthFlowError('EMAIL_CODE_INVALID', 'The code is not correct');
  }
}
