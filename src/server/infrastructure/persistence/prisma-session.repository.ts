import { Injectable } from '@nestjs/common';
import type { Session as PrismaSession } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Session } from '../../domain/entities/session';
import {
  SessionRepository,
  type CreateSessionInput,
} from '../../domain/repositories/session.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaSession): Session {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    userId: row.userId,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

@Injectable()
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateSessionInput, tx?: TransactionHandle): Promise<Session> {
    const row = await clientOf(this.prisma, tx).session.create({ data: input });
    return toDomain(row);
  }

  async findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<Session | null> {
    const row = await clientOf(this.prisma, tx).session.findUnique({ where: { tokenHash } });
    return row === null ? null : toDomain(row);
  }

  async revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).session.update({ where: { id }, data: { revokedAt } });
  }

  async revokeAllForUser(userId: string, revokedAt: Date, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
    return result.count;
  }
}
