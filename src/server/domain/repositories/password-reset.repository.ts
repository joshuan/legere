import type { TransactionHandle } from '../../application/ports/unit-of-work';

// PasswordReset entity (docs/03 §3.3.5): an admin-generated, single-use reset link.
export type PasswordReset = {
  id: string;
  userId: string;
  createdById: string;
  expiresAt: Date;
  revokedAt: Date | null;
  usedAt: Date | null;
  createdAt: Date;
};

export function isPasswordResetValid(reset: PasswordReset, now: Date): boolean {
  return (
    reset.revokedAt === null && reset.usedAt === null && reset.expiresAt.getTime() > now.getTime()
  );
}

export abstract class PasswordResetRepository {
  abstract findByTokenHash(
    tokenHash: string,
    tx?: TransactionHandle,
  ): Promise<PasswordReset | null>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<PasswordReset | null>;

  abstract create(input: CreatePasswordResetInput, tx?: TransactionHandle): Promise<PasswordReset>;

  // Spends the reset link (docs/08 §8.1.6, "single-use reset link"). A **conditional** write, for
  // the same reason markAccepted is one: the row is updated only while it still satisfies
  // isPasswordResetValid, and `false` means somebody else had already spent, revoked or outlived it.
  abstract markUsed(id: string, usedAt: Date, tx?: TransactionHandle): Promise<boolean>;

  // Deactivating a user invalidates their pending resets (docs/03 §3.3.1).
  abstract revokeAllForUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionHandle,
  ): Promise<number>;

  // Maintenance purge of expired rows (docs/06 §6.3.2).
  abstract deleteExpired(now: Date, tx?: TransactionHandle): Promise<number>;
}

export type CreatePasswordResetInput = {
  userId: string;
  tokenHash: string;
  createdById: string;
  expiresAt: Date;
};
