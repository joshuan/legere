import { USER_AGENT_MAX_LENGTH } from '../../domain/entities/session';
import type { SessionRepository } from '../../domain/repositories/session.repository';
import type { Clock } from '../ports/clock';
import type { SessionTokens } from '../ports/session-tokens';
import type { TransactionHandle } from '../ports/unit-of-work';

// Creating a session is shared by registration completion and login (docs/08 §8.2). Always a new
// session — never a reused token — which is what makes login immune to session fixation.
export class IssueSession {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
    private readonly sessionTtlDays: number,
  ) {}

  async execute(
    userId: string,
    userAgent: string | null,
    tx?: TransactionHandle,
  ): Promise<{ token: string; expiresAt: Date }> {
    const { token, hash } = this.tokens.generate();
    const expiresAt = new Date(
      this.clock.now().getTime() + this.sessionTtlDays * 24 * 60 * 60 * 1000,
    );

    await this.sessions.create(
      {
        tokenHash: hash,
        userId,
        userAgent: userAgent === null ? null : userAgent.slice(0, USER_AGENT_MAX_LENGTH),
        expiresAt,
      },
      tx,
    );

    return { token, expiresAt };
  }
}
