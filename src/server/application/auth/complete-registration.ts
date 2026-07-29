import type { UserDto } from '../../../shared/contracts/auth';
import type { Language } from '../../../shared/contracts/enums';
import { isTicketUsable } from '../../domain/entities/email-verification';
import { defaultDisplayName, type User } from '../../domain/entities/user';
import { AuthFlowError, ConflictError } from '../../domain/errors/domain-error';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import type { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { PasswordHasher } from '../ports/password-hasher';
import type { SessionTokens } from '../ports/session-tokens';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { IssueSession } from './issue-session';

export type CompleteRegistrationInput = {
  ticket: string;
  password: string;
  language: Language;
  userAgent: string | null;
};

export type CompleteRegistrationResult = {
  user: UserDto;
  sessionToken: string;
};

// POST /api/auth/register/complete (docs/08 §8.1.3 step 3).
//
// This is where the account finally comes into existence — or, for a reset series, where the
// password changes. Everything happens in one transaction: consuming the ticket, creating/updating
// the user, marking the invite or reset used, and issuing the session. Two callers racing on the
// same address both reach the insert; the partial unique index lets exactly one win and the loser
// surfaces as EMAIL_ALREADY_REGISTERED, which is also what makes concurrent onboarding produce a
// single admin.
export class CompleteRegistration {
  constructor(
    private readonly users: UserRepository,
    private readonly verifications: EmailVerificationRepository,
    private readonly invites: UserInviteRepository,
    private readonly passwordResets: PasswordResetRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: SessionTokens,
    private readonly issueSession: IssueSession,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: CompleteRegistrationInput): Promise<CompleteRegistrationResult> {
    const now = this.clock.now();
    const ticketHash = this.tokens.hash(input.ticket);
    const passwordHash = await this.hasher.hash(input.password);

    return this.unitOfWork.run(async (tx) => {
      const verification = await this.verifications.findByTicketHash(ticketHash, tx);
      if (verification === null || !isTicketUsable(verification, now)) {
        throw new AuthFlowError(
          'REGISTRATION_TICKET_INVALID',
          'The registration ticket is invalid',
        );
      }
      await this.verifications.markConsumed(verification.id, now, tx);

      const user =
        verification.purpose === 'PASSWORD_RESET'
          ? await this.resetPassword(verification.passwordResetId, passwordHash, now, tx)
          : await this.createUser(
              verification.inviteId,
              verification.email,
              passwordHash,
              input,
              tx,
            );

      const { token } = await this.issueSession.execute(user.id, input.userAgent, tx);
      return { user: toUserDto(user), sessionToken: token };
    });
  }

  private async createUser(
    inviteId: string | null,
    email: string,
    passwordHash: string,
    input: CompleteRegistrationInput,
    tx: unknown,
  ): Promise<User> {
    // Role comes from the invite; a tokenless series can only exist while onboarding is open
    // (StartRegistration enforces that), so its user is the first admin.
    let role: 'ADMIN' | 'USER' = 'ADMIN';
    if (inviteId !== null) {
      const invite = await this.invites.findById(inviteId, tx);
      if (invite === null) {
        throw new AuthFlowError('INVITE_INVALID', 'Invite link is not valid');
      }
      role = invite.role;
    } else {
      // Onboarding: serialize with any concurrent onboarding, then re-check. Without the lock two
      // callers with different addresses would both read zero and both become admins.
      await this.users.lockOnboarding(tx);
      if ((await this.users.countActive(tx)) > 0) {
        throw new ConflictError('EMAIL_ALREADY_REGISTERED', 'Registration is closed');
      }
    }

    const user = await this.users.create(
      {
        email,
        passwordHash,
        displayName: defaultDisplayName(email),
        role,
        language: input.language,
      },
      tx,
    );

    if (inviteId !== null) {
      await this.invites.markAccepted(inviteId, user.id, this.clock.now(), tx);
    }
    return user;
  }

  // Reset series: the password changes and every existing session dies (docs/08 §8.1.6). The new
  // session issued below is deliberately created after the revocation, so the user stays signed in
  // on this device only.
  private async resetPassword(
    passwordResetId: string | null,
    passwordHash: string,
    now: Date,
    tx: unknown,
  ): Promise<User> {
    if (passwordResetId === null) {
      throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
    }
    const reset = await this.passwordResets.findById(passwordResetId, tx);
    if (reset === null) {
      throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
    }

    const user = await this.users.update(reset.userId, { passwordHash }, tx);
    await this.sessions.revokeAllForUser(user.id, now, tx);
    await this.passwordResets.markUsed(reset.id, now, tx);
    return user;
  }
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    language: user.language,
    theme: user.theme,
    createdAt: user.createdAt.toISOString(),
  };
}
