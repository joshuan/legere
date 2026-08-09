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

  // Looked up by id so a revocation can check whose session it is before ending it (docs/08 §8.2).
  abstract findById(id: string, tx?: TransactionHandle): Promise<Session | null>;

  // The owner's own live sessions, newest first: not revoked and not yet expired. A dead session is
  // nothing anybody can act on, so it is left out of the list rather than shown as a corpse.
  abstract listActiveForUser(userId: string, now: Date, tx?: TransactionHandle): Promise<Session[]>;

  abstract revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Logout-everywhere: password reset, deactivation, admin revocation (docs/08 §8.1.6, §8.3).
  abstract revokeAllForUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionHandle,
  ): Promise<number>;

  // Logout-everywhere-else: a password change keeps the session that made it and ends the rest, so
  // the person doing the rotation is not signed out by their own repair (docs/08 §8.1.6a).
  abstract revokeAllForUserExcept(
    userId: string,
    exceptSessionId: string,
    revokedAt: Date,
    tx?: TransactionHandle,
  ): Promise<number>;
}
