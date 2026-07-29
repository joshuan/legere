import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Session } from '../entities/session';

export type CreateSessionInput = {
  tokenHash: string;
  userId: string;
  userAgent: string | null;
  expiresAt: Date;
};

export abstract class SessionRepository {
  abstract create(input: CreateSessionInput, tx?: TransactionHandle): Promise<Session>;

  abstract findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<Session | null>;

  abstract revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Logout-everywhere: password reset, deactivation, admin revocation (docs/08 §8.1.6, §8.3).
  abstract revokeAllForUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionHandle,
  ): Promise<number>;
}
