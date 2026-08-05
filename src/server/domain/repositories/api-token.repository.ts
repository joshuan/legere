import type { TransactionHandle } from '../../application/ports/unit-of-work';

// ApiToken entity (docs/03 §3.3.22): a read-only bearer credential a user issues to themselves.
export type ApiToken = {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

// Usable = not revoked, not expired. Whether the owner is still an active account is a separate
// question, asked of the user (docs/03 §3.3.22), exactly as for a session.
export function isApiTokenUsable(token: ApiToken, now: Date): boolean {
  return token.revokedAt === null && token.expiresAt.getTime() > now.getTime();
}

export type CreateApiTokenInput = {
  userId: string;
  name: string;
  tokenHash: string;
  expiresAt: Date;
};

export abstract class ApiTokenRepository {
  abstract create(input: CreateApiTokenInput, tx?: TransactionHandle): Promise<ApiToken>;

  abstract findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<ApiToken | null>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<ApiToken | null>;

  // Every token the user ever made, newest first: a revoked one is part of the answer to "what did
  // I hand out?" (docs/11 §11.9).
  abstract listForUser(userId: string, tx?: TransactionHandle): Promise<ApiToken[]>;

  abstract revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Deactivating or deleting a user ends their tokens with their sessions (docs/03 §3.3.22).
  abstract revokeAllForUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionHandle,
  ): Promise<number>;

  // Best-effort usage stamp; the caller decides how often it is worth a write.
  abstract touch(id: string, lastUsedAt: Date, tx?: TransactionHandle): Promise<void>;
}
