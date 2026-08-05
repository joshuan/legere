import type {
  ApiTokenDto,
  ApiTokenStatus,
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  ListApiTokensResponse,
} from '../../../shared/contracts/users';
import { NotFoundError } from '../../domain/errors/domain-error';
import {
  isApiTokenUsable,
  type ApiToken,
  type ApiTokenRepository,
} from '../../domain/repositories/api-token.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';
import { API_TOKEN_PREFIX } from '../auth/authenticate-api-token';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// POST /api/me/api-tokens (docs/07 §7.3). The plaintext leaves in this response and nowhere else;
// the database gets its hash, so a dump of the table hands out nothing (docs/08 §8.2a).
export class CreateApiToken {
  constructor(
    private readonly apiTokens: ApiTokenRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
    private readonly defaultTtlDays: number,
  ) {}

  async execute(userId: string, input: CreateApiTokenRequest): Promise<CreateApiTokenResponse> {
    const now = this.clock.now();
    const days = input.expiresInDays ?? this.defaultTtlDays;
    const plaintext = `${API_TOKEN_PREFIX}${this.tokens.generate().token}`;

    const created = await this.apiTokens.create({
      userId,
      name: input.name,
      tokenHash: this.tokens.hash(plaintext),
      expiresAt: new Date(now.getTime() + days * MS_PER_DAY),
    });

    return { token: plaintext, apiToken: toApiTokenDto(created, now) };
  }
}

// GET /api/me/api-tokens — everything the owner ever issued, newest first. A revoked or expired row
// stays in the list: "what did I hand out, and is it still alive?" is one question (docs/11 §11.9).
export class ListApiTokens {
  constructor(
    private readonly apiTokens: ApiTokenRepository,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string): Promise<ListApiTokensResponse> {
    const now = this.clock.now();
    const items = await this.apiTokens.listForUser(userId);
    return { items: items.map((token) => toApiTokenDto(token, now)) };
  }
}

// DELETE /api/me/api-tokens/:id — revoking twice is not an error; the token is dead either way.
// Somebody else's token is not found rather than forbidden: its existence is none of their business.
export class RevokeApiToken {
  constructor(
    private readonly apiTokens: ApiTokenRepository,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string, id: string): Promise<void> {
    const token = await this.apiTokens.findById(id);
    if (token === null || token.userId !== userId) {
      throw new NotFoundError('API_TOKEN_NOT_FOUND', 'No such API token');
    }
    if (token.revokedAt !== null) return;

    await this.apiTokens.revoke(id, this.clock.now());
  }
}

export function toApiTokenDto(token: ApiToken, now: Date): ApiTokenDto {
  return {
    id: token.id,
    name: token.name,
    status: statusOf(token, now),
    createdAt: token.createdAt.toISOString(),
    expiresAt: token.expiresAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    revokedAt: token.revokedAt?.toISOString() ?? null,
  };
}

// Revocation is a decision somebody made; expiry merely happened. When both are true the decision
// is the more useful thing to show.
function statusOf(token: ApiToken, now: Date): ApiTokenStatus {
  if (token.revokedAt !== null) return 'REVOKED';
  return isApiTokenUsable(token, now) ? 'ACTIVE' : 'EXPIRED';
}
