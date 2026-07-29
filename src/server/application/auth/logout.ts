import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { Clock } from '../ports/clock';

// POST /api/auth/logout (docs/08 §8.2): revokes the session the caller presented. Idempotent — a
// second call with the same (already revoked) session is not an error.
export class Logout {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, this.clock.now());
  }
}
