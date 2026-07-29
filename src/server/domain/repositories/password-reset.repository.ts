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

  abstract markUsed(id: string, usedAt: Date, tx?: TransactionHandle): Promise<void>;
}
