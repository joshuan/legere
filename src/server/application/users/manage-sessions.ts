import type { ListSessionsResponse, SessionDto } from '../../../shared/contracts/users';
import type { Session } from '../../domain/entities/session';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { Clock } from '../ports/clock';
import type { SecurityEvents } from '../ports/security-events';

// A user's own sessions (docs/07 §7.3, docs/08 §8.2). An admin can already end somebody's sessions;
// this is the same power in the hands of the person it belongs to, next to the API tokens they
// already manage on /settings — a credential you cannot see is a credential you cannot revoke.

// GET /api/me/sessions — live sessions only, newest first. Revoked and expired rows are left out:
// unlike an API token, whose history answers "what did I hand out", a dead session is a fact about
// a browser that has already stopped mattering.
export class ListMySessions {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(userId: string, currentSessionId: string): Promise<ListSessionsResponse> {
    const items = await this.sessions.listActiveForUser(userId, this.clock.now());
    return { items: items.map((session) => toSessionDto(session, currentSessionId)) };
  }
}

// DELETE /api/me/sessions/:id — revoking twice is not an error, and revoking the current one is
// allowed: signing this device out from the list is exactly what the list is for. Somebody else's
// session is not found rather than forbidden — that it exists is none of their business.
export class RevokeMySession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
    private readonly events: SecurityEvents,
  ) {}

  async execute(userId: string, id: string): Promise<void> {
    const session = await this.sessions.findById(id);
    if (session === null || session.userId !== userId) {
      throw new NotFoundError('SESSION_NOT_FOUND', 'No such session');
    }
    if (session.revokedAt !== null) return;

    await this.sessions.revoke(id, this.clock.now());
    // The same event an admin's revoke-all produces, with the owner as its own actor: what an
    // incident asks is which sessions ended and who ended them (docs/06 §6.7).
    this.events.record({
      event: 'session.revoked',
      actor: { userId },
      target: { userId, id },
      detail: { sessions: 1 },
    });
  }
}

export function toSessionDto(session: Session, currentSessionId: string): SessionDto {
  return {
    id: session.id,
    userAgent: session.userAgent,
    current: session.id === currentSessionId,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}
