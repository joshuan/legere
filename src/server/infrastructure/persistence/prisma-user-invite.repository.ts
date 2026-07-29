import { Injectable } from '@nestjs/common';
import type { UserInvite as PrismaUserInvite } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  UserInviteRepository,
  type UserInvite,
} from '../../domain/repositories/user-invite.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaUserInvite): UserInvite {
  return {
    id: row.id,
    role: row.role,
    emailHint: row.emailHint,
    createdById: row.createdById,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    acceptedAt: row.acceptedAt,
    acceptedById: row.acceptedById,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaUserInviteRepository implements UserInviteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<UserInvite | null> {
    const row = await clientOf(this.prisma, tx).userInvite.findUnique({ where: { tokenHash } });
    return row === null ? null : toDomain(row);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<UserInvite | null> {
    const row = await clientOf(this.prisma, tx).userInvite.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async markAccepted(
    id: string,
    acceptedById: string,
    acceptedAt: Date,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).userInvite.update({
      where: { id },
      data: { acceptedById, acceptedAt },
    });
  }
}
