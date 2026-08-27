import type { RegisterVerifyResponse } from '../../../shared/contracts/auth';
import {
  isCodeUsable,
  MAX_CODE_ATTEMPTS,
  type EmailVerification,
  type VerificationPurpose,
} from '../../domain/entities/email-verification';
import { AuthFlowError, RateLimitedError } from '../../domain/errors/domain-error';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import type { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import type { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';
import type { VerificationCodes } from '../ports/verification-codes';

export type VerifyEmailCodeInput = {
  email: string;
  code: string;
  inviteToken?: string | undefined;
  resetToken?: string | undefined;
};

// The ticket handed to step 3 is single-use and short-lived (docs/03 §3.3.3).
const TICKET_TTL_MS = 15 * 60 * 1000;

// POST /api/auth/register/verify (docs/08 §8.1.3 step 2). A correct code exchanges the series for a
// registration ticket; five wrong ones burn the record entirely, so guessing a six-digit code costs
// a fresh email round-trip every five tries.
export class VerifyEmailCode {
  constructor(
    private readonly verifications: EmailVerificationRepository,
    private readonly invites: UserInviteRepository,
    private readonly passwordResets: PasswordResetRepository,
    private readonly codes: VerificationCodes,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(input: VerifyEmailCodeInput): Promise<RegisterVerifyResponse> {
    const now = this.clock.now();
    const verification = await this.findUsableSeries(input, now);

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
  //
  // 🔒 A reset wins over a registration when both exist, and the order is the whole point. A reset
  // series exists only because an admin issued one against an account that is already here; a
  // registration series against the same address can be created by anyone holding an invite
  // (§8.1.2). Taking registration first therefore let a stranger's series swallow the attempts of
  // the owner's real reset — five correctly typed codes burning a series they never asked for
  // (docs/08 §8.4, security audit SEC-19). An address with no account can have no reset series, so
  // ordinary sign-up is untouched.
  //
  // 🔒 And the series a caller is measured against is the first one they can prove is theirs. The
  // proof stands here, in front of the attempt counter, because the counter is the thing being
  // defended: an address alone used to choose the series, so anybody who knew one could spend its
  // five guesses and burn the row, and the owner's own correct code then answered
  // EMAIL_CODE_INVALID (docs/08 §8.1.3 step 2, SEC-57). A caller who proves nothing is refused with
  // that same answer and moves no counter.
  //
  // The code is deliberately *not* consulted here: the attempt counter is the only gate, and
  // comparing before it would let a guess be tested without being counted.
  private async findUsableSeries(input: VerifyEmailCodeInput, now: Date) {
    const purposes: VerificationPurpose[] = ['PASSWORD_RESET', 'REGISTRATION'];
    for (const purpose of purposes) {
      const found = await this.verifications.findActive(input.email, purpose);
      if (found === null || !isCodeUsable(found, now)) continue;
      if (await this.holdsSeriesLink(found, input)) return found;
    }
    throw new AuthFlowError('EMAIL_CODE_INVALID', 'The code is not correct');
  }

  // Possession of the link the series was made from, and nothing more: whether that link is still
  // spendable is step 3's question, asked again inside the transaction that spends it
  // (CompleteRegistration). A series with neither id is the onboarding one — nobody holds a link to
  // it, and while onboarding is open anybody who can reach the instance can finish it anyway, so
  // there is no account behind that code to defend (docs/08 §8.1.3 step 2).
  private async holdsSeriesLink(
    verification: EmailVerification,
    input: VerifyEmailCodeInput,
  ): Promise<boolean> {
    if (verification.passwordResetId !== null) {
      if (input.resetToken === undefined) return false;
      const reset = await this.passwordResets.findByTokenHash(this.tokens.hash(input.resetToken));
      return reset !== null && reset.id === verification.passwordResetId;
    }
    if (verification.inviteId !== null) {
      if (input.inviteToken === undefined) return false;
      const invite = await this.invites.findByTokenHash(this.tokens.hash(input.inviteToken));
      return invite !== null && invite.id === verification.inviteId;
    }
    return true;
  }
}
