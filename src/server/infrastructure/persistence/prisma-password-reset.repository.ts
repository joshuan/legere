import { Injectable } from '@nestjs/common';
import type { PasswordReset as PrismaPasswordReset } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  PasswordResetRepository,
  type CreatePasswordResetInput,
  type PasswordReset,
} from '../../domain/repositories/password-reset.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaPasswordReset): PasswordReset {
  return {
    id: row.id,
    userId: row.userId,
    createdById: row.createdById,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    usedAt: row.usedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaPasswordResetRepository implements PasswordResetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<PasswordReset | null> {
    const row = await clientOf(this.prisma, tx).passwordReset.findUnique({ where: { tokenHash } });
    return row === null ? null : toDomain(row);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<PasswordReset | null> {
    const row = await clientOf(this.prisma, tx).passwordReset.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async create(input: CreatePasswordResetInput, tx?: TransactionHandle): Promise<PasswordReset> {
    const row = await clientOf(this.prisma, tx).passwordReset.create({ data: input });
    return toDomain(row);
  }

  async markUsed(id: string, usedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).passwordReset.update({ where: { id }, data: { usedAt } });
  }

  async revokeAllForUser(userId: string, revokedAt: Date, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).passwordReset.updateMany({
      where: { userId, revokedAt: null, usedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async deleteExpired(now: Date, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).passwordReset.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
