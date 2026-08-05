import { isUserActive } from '../../domain/entities/user';
import { ForbiddenError, UnauthenticatedError } from '../../domain/errors/domain-error';
import {
  isApiTokenUsable,
  type ApiTokenRepository,
} from '../../domain/repositories/api-token.repository';
import type { UserRepository } from '../../domain/repositories/user.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';
import type { AuthenticatedCaller } from './authenticate-session';

// Not a secret and not a check: the prefix exists so the string is recognisable in a config file
// and to a secret scanner (docs/08 §8.2a). It is part of what gets hashed, so it cannot be dropped.
export const API_TOKEN_PREFIX = 'legere_';

// A usage stamp is worth a write once a minute, not once a request: the list answers "is this one
// still in use?", which no finer resolution improves (docs/08 §8.2a).
const TOUCH_INTERVAL_MS = 60_000;

// Resolves an `Authorization: Bearer` credential into the caller behind it (docs/08 §8.2a). The
// same three questions as a session asks — live credential, existing user, active account — because
// a token is a session's smaller sibling, not a different kind of authority.
export class AuthenticateApiToken {
  constructor(
    private readonly apiTokens: ApiTokenRepository,
    private readonly users: UserRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(presented: string | undefined): Promise<AuthenticatedCaller> {
    if (presented === undefined || !presented.startsWith(API_TOKEN_PREFIX)) {
      throw new UnauthenticatedError();
    }

    const now = this.clock.now();
    const apiToken = await this.apiTokens.findByTokenHash(this.tokens.hash(presented));
    if (apiToken === null || !isApiTokenUsable(apiToken, now)) throw new UnauthenticatedError();

    const user = await this.users.findById(apiToken.userId);
    if (user === null) throw new UnauthenticatedError();
    // Deactivation is an authorization decision, as it is for sessions (docs/07 §7.2).
    if (!isUserActive(user)) throw new ForbiddenError('This account is deactivated');

    if (
      apiToken.lastUsedAt === null ||
      now.getTime() - apiToken.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS
    ) {
      await this.apiTokens.touch(apiToken.id, now);
    }

    return { kind: 'API_TOKEN', user, apiToken };
  }
}
