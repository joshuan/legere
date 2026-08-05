import { Injectable } from '@nestjs/common';
import type { ApiToken as PrismaApiToken } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  ApiTokenRepository,
  type ApiToken,
  type CreateApiTokenInput,
} from '../../domain/repositories/api-token.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaApiToken): ApiToken {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateApiTokenInput, tx?: TransactionHandle): Promise<ApiToken> {
    const row = await clientOf(this.prisma, tx).apiToken.create({ data: input });
    return toDomain(row);
  }

  async findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<ApiToken | null> {
    const row = await clientOf(this.prisma, tx).apiToken.findUnique({ where: { tokenHash } });
    return row === null ? null : toDomain(row);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<ApiToken | null> {
    const row = await clientOf(this.prisma, tx).apiToken.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async listForUser(userId: string, tx?: TransactionHandle): Promise<ApiToken[]> {
    const rows = await clientOf(this.prisma, tx).apiToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDomain);
  }

  async revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).apiToken.update({ where: { id }, data: { revokedAt } });
  }

  async revokeAllForUser(userId: string, revokedAt: Date, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).apiToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }

  async touch(id: string, lastUsedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).apiToken.update({ where: { id }, data: { lastUsedAt } });
  }
}
