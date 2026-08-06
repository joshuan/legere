import type { UserRole } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';

// UserInvite entity (docs/03 §3.3.4). Valid = not expired, not revoked, not accepted.
export type UserInvite = {
  id: string;
  role: UserRole;
  emailHint: string | null;
  createdById: string;
  expiresAt: Date;
  revokedAt: Date | null;
  acceptedAt: Date | null;
  acceptedById: string | null;
  createdAt: Date;
};

export function isInviteValid(invite: UserInvite, now: Date): boolean {
  return (
    invite.revokedAt === null &&
    invite.acceptedAt === null &&
    invite.expiresAt.getTime() > now.getTime()
  );
}

export type CreateUserInviteInput = {
  tokenHash: string;
  role: UserRole;
  emailHint: string | null;
  createdById: string;
  expiresAt: Date;
};

export abstract class UserInviteRepository {
  abstract findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<UserInvite | null>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<UserInvite | null>;

  abstract create(input: CreateUserInviteInput, tx?: TransactionHandle): Promise<UserInvite>;

  // Invites still usable right now: unrevoked, unaccepted, unexpired (docs/07 admin invites).
  abstract listActive(now: Date, tx?: TransactionHandle): Promise<UserInvite[]>;

  abstract revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Spends the invite (docs/08 §8.1.2, "single-use link"). A **conditional** write: the row moves
  // to accepted only while it still satisfies isInviteValid, and the answer says whether this call
  // is the one that spent it. Reading the invite and then updating it would not do — the
  // transactions this runs in are READ COMMITTED, so two completions racing on one link both see
  // `acceptedAt = null`; only the write can decide between them, and `false` means the caller lost.
  abstract markAccepted(
    id: string,
    acceptedById: string,
    acceptedAt: Date,
    tx?: TransactionHandle,
  ): Promise<boolean>;

  // Maintenance purge of expired rows (docs/06 §6.3.2).
  abstract deleteExpired(now: Date, tx?: TransactionHandle): Promise<number>;
}
