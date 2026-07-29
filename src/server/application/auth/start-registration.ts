import type { RegisterStartResponse } from '../../../shared/contracts/auth';
import type { VerificationPurpose } from '../../domain/entities/email-verification';
import { AuthFlowError, RateLimitedError } from '../../domain/errors/domain-error';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import {
  isPasswordResetValid,
  type PasswordResetRepository,
} from '../../domain/repositories/password-reset.repository';
import {
  isInviteValid,
  type UserInviteRepository,
} from '../../domain/repositories/user-invite.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { CaptchaVerifier } from '../ports/captcha-verifier';
import type { Clock } from '../ports/clock';
import type { EmailSender } from '../ports/email-sender';
import type { EmailSendThrottle } from '../ports/email-send-throttle';
import type { SessionTokens } from '../ports/session-tokens';
import type { VerificationCodes } from '../ports/verification-codes';

export type StartRegistrationInput = {
  email: string;
  inviteToken?: string | undefined;
  resetToken?: string | undefined;
  captchaToken?: string | undefined;
  ip?: string | undefined;
};

// Code lifetime and the minimum gap between two codes for one address (docs/08 §8.1.3, §8.4).
const CODE_TTL_MS = 10 * 60 * 1000;
const MIN_RESEND_INTERVAL_MS = 60 * 1000;

// POST /api/auth/register/start (docs/08 §8.1.3 step 1).
//
// Anti-enumeration: the response is always 200 with the same shape — whether the address is already
// registered, unknown, or nothing was sent at all. The letter's wording differs, the API's answer
// does not. Errors are only raised for things the caller can see anyway: a bad CAPTCHA, an invalid
// invite/reset token, or hitting a rate limit.
export class StartRegistration {
  constructor(
    private readonly users: UserRepository,
    private readonly verifications: EmailVerificationRepository,
    private readonly invites: UserInviteRepository,
    private readonly passwordResets: PasswordResetRepository,
    private readonly codes: VerificationCodes,
    private readonly tokens: SessionTokens,
    private readonly email: EmailSender,
    private readonly captcha: CaptchaVerifier,
    private readonly throttle: EmailSendThrottle,
    private readonly clock: Clock,
    private readonly appBaseUrl: string,
  ) {}

  async execute(input: StartRegistrationInput): Promise<RegisterStartResponse> {
    if (!(await this.captcha.verify(input.captchaToken, input.ip))) {
      throw new AuthFlowError('CAPTCHA_FAILED', 'CAPTCHA verification failed');
    }

    const now = this.clock.now();
    const { purpose, inviteId, passwordResetId } = await this.resolveEntryPath(input, now);

    const existing = await this.verifications.findActive(input.email, purpose);
    if (existing !== null && this.tooSoon(existing.createdAt, now)) {
      throw new RateLimitedError('RATE_LIMITED', 'A code was already sent recently');
    }
    if (!this.throttle.canSend(input.email)) {
      throw new RateLimitedError('RATE_LIMITED', 'Too many codes requested for this address');
    }

    const code = this.codes.generate();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
    await this.verifications.replace({
      email: input.email,
      purpose,
      codeHash: this.codes.hash(code),
      expiresAt,
      inviteId,
      passwordResetId,
    });
    this.throttle.record(input.email);

    const alreadyRegistered = (await this.users.findActiveByEmail(input.email)) !== null;
    await this.email.send({
      to: input.email,
      subject: this.subjectFor(purpose),
      text: this.bodyFor(purpose, code, alreadyRegistered),
    });

    return { expiresAt: expiresAt.toISOString() };
  }

  // Which flow this is, and whether the caller is allowed to start it at all (docs/07 §7.3):
  // a tokenless start is only possible while onboarding is still required.
  private async resolveEntryPath(
    input: StartRegistrationInput,
    now: Date,
  ): Promise<{
    purpose: VerificationPurpose;
    inviteId: string | null;
    passwordResetId: string | null;
  }> {
    if (input.resetToken !== undefined) {
      const reset = await this.passwordResets.findByTokenHash(this.tokens.hash(input.resetToken));
      if (reset === null || !isPasswordResetValid(reset, now)) {
        throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
      }
      return { purpose: 'PASSWORD_RESET', inviteId: null, passwordResetId: reset.id };
    }

    if (input.inviteToken !== undefined) {
      const invite = await this.invites.findByTokenHash(this.tokens.hash(input.inviteToken));
      if (invite === null || !isInviteValid(invite, now)) {
        throw new AuthFlowError('INVITE_INVALID', 'Invite link is not valid');
      }
      return { purpose: 'REGISTRATION', inviteId: invite.id, passwordResetId: null };
    }

    if ((await this.users.countActive()) > 0) {
      throw new AuthFlowError('INVITE_INVALID', 'Registration requires an invite');
    }
    return { purpose: 'REGISTRATION', inviteId: null, passwordResetId: null };
  }

  private tooSoon(lastSentAt: Date, now: Date): boolean {
    return now.getTime() - lastSentAt.getTime() < MIN_RESEND_INTERVAL_MS;
  }

  private subjectFor(purpose: VerificationPurpose): string {
    return purpose === 'PASSWORD_RESET' ? 'Legere password reset code' : 'Legere sign-up code';
  }

  private bodyFor(purpose: VerificationPurpose, code: string, alreadyRegistered: boolean): string {
    if (purpose === 'REGISTRATION' && alreadyRegistered) {
      return [
        `You already have a Legere account at ${this.appBaseUrl}.`,
        'If you wanted to sign in, use your existing password.',
        'If you have forgotten it, ask an administrator for a reset link.',
        '',
        `If you did start a sign-up, your code is ${code} (valid for 10 minutes).`,
      ].join('\n');
    }
    const action = purpose === 'PASSWORD_RESET' ? 'reset your password' : 'finish signing up';
    return [
      `Your Legere code is ${code}.`,
      `Enter it at ${this.appBaseUrl} to ${action}. It is valid for 10 minutes.`,
      '',
      'If you did not request this, you can ignore this message.',
    ].join('\n');
  }
}
