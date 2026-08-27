import type { UserDto } from '../../../shared/contracts/auth';
import type { Language } from '../../../shared/contracts/enums';
import { isTicketUsable } from '../../domain/entities/email-verification';
import { defaultDisplayName, isUserActive, type User } from '../../domain/entities/user';
import { AuthFlowError, ConflictError } from '../../domain/errors/domain-error';
import type { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import {
  isPasswordResetValid,
  type PasswordResetRepository,
} from '../../domain/repositories/password-reset.repository';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import {
  isInviteValid,
  type UserInviteRepository,
} from '../../domain/repositories/user-invite.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { PasswordHasher } from '../ports/password-hasher';
import type { SecurityEvent, SecurityEvents } from '../ports/security-events';
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
    private readonly apiTokens: ApiTokenRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: SessionTokens,
    private readonly issueSession: IssueSession,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: SecurityEvents,
  ) {}

  async execute(input: CompleteRegistrationInput): Promise<CompleteRegistrationResult> {
    const now = this.clock.now();
    const ticketHash = this.tokens.hash(input.ticket);
    const passwordHash = await this.hasher.hash(input.password);

    const completed = await this.unitOfWork.run(async (tx) => {
      const verification = await this.verifications.findByTicketHash(ticketHash, tx);
      if (verification === null || !isTicketUsable(verification, now)) {
        throw new AuthFlowError(
          'REGISTRATION_TICKET_INVALID',
          'The registration ticket is invalid',
        );
      }
      await this.verifications.markConsumed(verification.id, now, tx);

      const { user, event } =
        verification.purpose === 'PASSWORD_RESET'
          ? await this.resetPassword(verification.passwordResetId, passwordHash, now, tx)
          : await this.createUser(
              verification.inviteId,
              verification.email,
              passwordHash,
              now,
              input,
              tx,
            );

      const { token } = await this.issueSession.execute(user.id, input.userAgent, tx);
      return { user, event, token };
    });

    // After the commit, never inside it: an account that rolled back is not an account that was
    // created, and a journal that says otherwise is worse than one that says nothing (docs/06 §6.7).
    this.events.record(completed.event);
    return { user: toUserDto(completed.user), sessionToken: completed.token };
  }

  private async createUser(
    inviteId: string | null,
    email: string,
    passwordHash: string,
    now: Date,
    input: CompleteRegistrationInput,
    tx: unknown,
  ): Promise<{ user: User; event: SecurityEvent }> {
    // Role comes from the invite; a tokenless series can only exist while onboarding is open
    // (StartRegistration enforces that), so its user is the first admin.
    let role: 'ADMIN' | 'USER' = 'ADMIN';
    if (inviteId !== null) {
      // Re-checked here and not only at register/start: minutes pass between the two, and in them
      // the invite can be revoked, expire, or be spent by another series started from the same
      // link. Without this an invite is not single-use at all, and an ADMIN one mints admins
      // nobody sees in the panel (docs/08 §8.1.2).
      const invite = await this.invites.findById(inviteId, tx);
      if (invite === null || !isInviteValid(invite, now)) {
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
      // The read above is advisory; this write is the decision. Two completions racing on one link
      // both saw an unaccepted invite, and exactly one of them updates a row here — the other
      // rolls its freshly created account back with the transaction.
      const accepted = await this.invites.markAccepted(inviteId, user.id, now, tx);
      if (!accepted) {
        throw new AuthFlowError('INVITE_INVALID', 'Invite link is not valid');
      }
      return {
        user,
        event: {
          event: 'invite.accepted',
          actor: { userId: user.id },
          target: { userId: user.id, id: inviteId },
          detail: { role },
        },
      };
    }
    return {
      user,
      // The one account nobody invited: the first administrator of the instance (docs/08 §8.1.1).
      event: {
        event: 'account.created',
        actor: { userId: user.id },
        target: { userId: user.id },
        detail: { role },
      },
    };
  }

  // Reset series: the password changes and every existing session dies (docs/08 §8.1.6). The new
  // session issued below is deliberately created after the revocation, so the user stays signed in
  // on this device only.
  //
  // 🔒 And every API token dies with them. An admin issues a reset link for one reason — somebody
  // believes the account is in somebody else's hands — and a stranger who held a session for a
  // minute could have minted a read-only token from it, good for up to a year and invisible to the
  // admin, which the documented remediation then left reading the archive (docs/08 §8.1.6, §8.2a,
  // SEC-65). The self-service rotation of §8.1.6a deliberately keeps them: that is housekeeping,
  // this is recovery.
  private async resetPassword(
    passwordResetId: string | null,
    passwordHash: string,
    now: Date,
    tx: unknown,
  ): Promise<{ user: User; event: SecurityEvent }> {
    if (passwordResetId === null) {
      throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
    }
    // Revalidated here, not only at register/start: the link can be revoked or spent, and the
    // account deactivated, inside the fifteen minutes the ticket lives. DeactivateUser revokes
    // sessions, tokens and pending resets precisely to shut this door (docs/03 §3.3.1) — without
    // the checks, completion still wrote a password onto a blocked account, waiting for the day it
    // is reactivated.
    const reset = await this.passwordResets.findById(passwordResetId, tx);
    if (reset === null || !isPasswordResetValid(reset, now)) {
      throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
    }
    const target = await this.users.findById(reset.userId, tx);
    if (target === null || !isUserActive(target)) {
      throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
    }

    // Spend the link before writing the password: two completions racing on one reset both saw it
    // unused, and only the one whose conditional write moves a row may go on.
    if (!(await this.passwordResets.markUsed(reset.id, now, tx))) {
      throw new AuthFlowError('RESET_INVALID', 'Password reset link is not valid');
    }

    const user = await this.users.update(reset.userId, { passwordHash }, tx);
    const sessions = await this.sessions.revokeAllForUser(user.id, now, tx);
    const apiTokens = await this.apiTokens.revokeAllForUser(user.id, now, tx);
    return {
      user,
      event: {
        event: 'password_reset.completed',
        actor: { userId: user.id },
        target: { userId: user.id, id: reset.id },
        detail: { sessions, apiTokens },
      },
    };
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
