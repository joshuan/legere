import { Injectable } from '@nestjs/common';
import type { ApiToken as PrismaApiToken, Integration, OAuthGrant } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  ApiTokenRepository,
  type ApiToken,
  type CreateApiTokenInput,
} from '../../domain/repositories/api-token.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

const BINDINGS = { integration: true, oauthGrant: true } as const;

function toDomain(
  row: PrismaApiToken & { integration?: Integration | null; oauthGrant?: OAuthGrant | null },
): ApiToken {
  return {
    id: row.id,
    integrationId: row.integrationId,
    integrationName: row.integration?.name ?? null,
    oauthGrantId: row.oauthGrantId,
    oauthClientId: row.oauthGrant?.clientId ?? null,
    oauthResource: row.oauthGrant?.resource ?? null,
    bindingExpiresAt: row.oauthGrant?.expiresAt ?? null,
    bindingActive:
      (row.integrationId === null ||
        (row.integration != null &&
          row.integration.revokedAt === null &&
          row.integration.userId === row.userId)) &&
      (row.oauthGrantId === null ||
        (row.oauthGrant != null &&
          row.oauthGrant.revokedAt === null &&
          row.oauthGrant.userId === row.userId)),
    userId: row.userId,
    name: row.name,
    scope: row.scope,
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
    const row = await clientOf(this.prisma, tx).apiToken.create({ data: input, include: BINDINGS });
    return toDomain(row);
  }

  async findByTokenHash(tokenHash: string, tx?: TransactionHandle): Promise<ApiToken | null> {
    const row = await clientOf(this.prisma, tx).apiToken.findUnique({
      where: { tokenHash },
      include: BINDINGS,
    });
    return row === null ? null : toDomain(row);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<ApiToken | null> {
    const row = await clientOf(this.prisma, tx).apiToken.findUnique({
      where: { id },
      include: BINDINGS,
    });
    return row === null ? null : toDomain(row);
  }

  async listForUser(userId: string, tx?: TransactionHandle): Promise<ApiToken[]> {
    const rows = await clientOf(this.prisma, tx).apiToken.findMany({
      where: { userId, oauthGrantId: null },
      include: BINDINGS,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDomain);
  }

  async revoke(id: string, revokedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).apiToken.update({ where: { id }, data: { revokedAt } });
  }

  async revokeAllForUser(userId: string, revokedAt: Date, tx?: TransactionHandle): Promise<number> {
    await clientOf(this.prisma, tx).oAuthGrant.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
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
