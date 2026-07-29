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

export abstract class UserInviteRepository {
  abstract findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<UserInvite | null>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<UserInvite | null>;

  abstract markAccepted(
    id: string,
    acceptedById: string,
    acceptedAt: Date,
    tx?: TransactionHandle,
  ): Promise<void>;
}
