import { isSessionActive, type Session } from '../../domain/entities/session';
import { isUserActive, type User } from '../../domain/entities/user';
import { ForbiddenError, UnauthenticatedError } from '../../domain/errors/domain-error';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';

export type AuthenticatedCaller = {
  user: User;
  session: Session;
};

// Resolves the `sid` cookie into the caller behind it (docs/08 §8.2). An active session requires the
// session itself to be live *and* its user to still exist and not be deactivated (docs/03 §3.3.2).
export class AuthenticateSession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly users: UserRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(token: string | undefined): Promise<AuthenticatedCaller> {
    if (token === undefined || token === '') throw new UnauthenticatedError();

    const session = await this.sessions.findByTokenHash(this.tokens.hash(token));
    if (session === null || !isSessionActive(session, this.clock.now())) {
      throw new UnauthenticatedError();
    }

    const user = await this.users.findById(session.userId);
    if (user === null) throw new UnauthenticatedError();

    // Deactivation is an authorization decision, not a missing credential: the caller holds a valid
    // session but the account is blocked (docs/07 §7.2).
    if (!isUserActive(user)) throw new ForbiddenError('This account is deactivated');

    return { user, session };
  }
}
