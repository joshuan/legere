import type { Provider } from '@nestjs/common';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from './session.guard';

// What `SessionGuard` needs to answer "who is this?": the session use case and, since docs/08 §8.2a,
// the API-token one. Every feature module guards its routes with it, so the wiring lives here once
// rather than as a copy per module that a new credential would have to be added to twelve times.
export const sessionGuardProviders: Provider[] = [
  SessionGuard,
  {
    provide: AuthenticateSession,
    useFactory: (
      sessions: SessionRepository,
      users: UserRepository,
      tokens: SessionTokens,
      clock: Clock,
    ): AuthenticateSession => new AuthenticateSession(sessions, users, tokens, clock),
    inject: [SessionRepository, UserRepository, SessionTokens, Clock],
  },
  {
    provide: AuthenticateApiToken,
    useFactory: (
      apiTokens: ApiTokenRepository,
      users: UserRepository,
      tokens: SessionTokens,
      clock: Clock,
    ): AuthenticateApiToken => new AuthenticateApiToken(apiTokens, users, tokens, clock),
    inject: [ApiTokenRepository, UserRepository, SessionTokens, Clock],
  },
];
