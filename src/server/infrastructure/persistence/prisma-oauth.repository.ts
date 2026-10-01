import { Injectable } from '@nestjs/common';
import { oauthClientAuthMethodSchema } from '../../../shared/contracts/oauth';
import {
  OAuthRepository,
  MAX_OAUTH_CLIENTS,
  type OAuthClient,
  type OAuthGrant,
  type OAuthCode,
  type OAuthRefreshToken,
} from '../../domain/repositories/oauth.repository';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { PrismaService } from './prisma.service';
import { clientOf } from './prisma-client';

@Injectable()
export class PrismaOAuthRepository extends OAuthRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }
  async register(input: Omit<OAuthClient, 'id' | 'createdAt'>): Promise<OAuthClient | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('legere-oauth-client-registration'))`;
      if ((await tx.oAuthClient.count()) >= MAX_OAUTH_CLIENTS) return null;
      const row = await tx.oAuthClient.create({ data: input });
      return { ...row, authMethod: oauthClientAuthMethodSchema.parse(row.authMethod) };
    });
  }
  async findClient(id: string): Promise<OAuthClient | null> {
    const row = await this.prisma.oAuthClient.findUnique({ where: { id } });
    return row === null
      ? null
      : { ...row, authMethod: oauthClientAuthMethodSchema.parse(row.authMethod) };
  }
  async createGrant(
    input: Omit<OAuthGrant, 'id' | 'createdAt' | 'revokedAt'>,
    tx: TransactionHandle,
  ) {
    return clientOf(this.prisma, tx).oAuthGrant.create({ data: input });
  }
  async lockGrant(id: string, tx: TransactionHandle) {
    const client = clientOf(this.prisma, tx);
    await client.$queryRaw`SELECT id FROM oauth_grants WHERE id = ${id}::uuid FOR UPDATE`;
    return client.oAuthGrant.findUnique({ where: { id } });
  }
  async listGrants(userId: string) {
    return this.prisma.oAuthGrant.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }
  async revokeGrant(id: string, now: Date, tx: TransactionHandle): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.oAuthGrant.update({ where: { id }, data: { revokedAt: now } });
    await client.apiToken.updateMany({
      where: { oauthGrantId: id, revokedAt: null },
      data: { revokedAt: now },
    });
  }
  async createCode(input: Omit<OAuthCode, 'consumedAt'>, tx: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).oAuthCode.create({ data: input });
  }
  async findCode(hash: string, tx: TransactionHandle) {
    return clientOf(this.prisma, tx).oAuthCode.findUnique({ where: { hash } });
  }
  async consumeCode(hash: string, now: Date, tx: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).oAuthCode.update({
      where: { hash },
      data: { consumedAt: now },
    });
  }
  async createRefresh(
    input: Omit<OAuthRefreshToken, 'consumedAt'>,
    tx: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).oAuthRefreshToken.create({ data: input });
  }
  async findRefresh(hash: string, tx: TransactionHandle) {
    return clientOf(this.prisma, tx).oAuthRefreshToken.findUnique({ where: { hash } });
  }
  async consumeRefresh(hash: string, now: Date, tx: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).oAuthRefreshToken.update({
      where: { hash },
      data: { consumedAt: now },
    });
  }
}
