import type { ChangePasswordResponse } from '../../../shared/contracts/users';
import { InvalidCredentialsError, NotFoundError } from '../../domain/errors/domain-error';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { PasswordHasher } from '../ports/password-hasher';
import type { SecurityEvents } from '../ports/security-events';
import type { UnitOfWork } from '../ports/unit-of-work';

export type ChangePasswordInput = {
  userId: string;
  // The session making the request: the one session the change deliberately keeps alive.
  currentSessionId: string;
  currentPassword: string;
  newPassword: string;
};

// POST /api/me/password (docs/08 §8.1.6a).
//
// A rotation, not a recovery: the caller is already signed in and proves it again with the password
// they are replacing. The recovery flow of §8.1.6 stays an admin's to start — this endpoint asks
// for something only the account's owner knows, so it needs nobody's help.
//
// 🔒 Every other session of that user ends with the change. Somebody who rotates a password because
// they think it leaked has to be able to end the sessions that leak bought, and the one session
// they are sitting in is the one they can vouch for.
export class ChangePassword {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly events: SecurityEvents,
  ) {}

  async execute(input: ChangePasswordInput): Promise<ChangePasswordResponse> {
    const user = await this.users.findById(input.userId);
    if (user === null) {
      throw new NotFoundError('USER_NOT_FOUND', 'No such user');
    }

    // The same answer a wrong password gets at login (docs/07 §7.2). There is no enumeration
    // question here — the caller's identity is already settled by the session guard.
    if (!(await this.hasher.verify(user.passwordHash, input.currentPassword))) {
      throw new InvalidCredentialsError();
    }

    const passwordHash = await this.hasher.hash(input.newPassword);
    const now = this.clock.now();

    // One transaction: a password written without the revocation that goes with it would leave the
    // stolen sessions alive under a password their owner believes they have just replaced.
    const { revoked } = await this.unitOfWork.run(async (tx) => {
      await this.users.update(user.id, { passwordHash }, tx);
      const sessions = await this.sessions.revokeAllForUserExcept(
        user.id,
        input.currentSessionId,
        now,
        tx,
      );
      return { revoked: sessions };
    });

    this.events.record({
      event: 'password.changed',
      actor: { userId: user.id },
      target: { userId: user.id },
      detail: { sessions: revoked },
    });
    return { revoked };
  }
}
