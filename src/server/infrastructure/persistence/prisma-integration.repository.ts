import { Injectable } from '@nestjs/common';
import { IntegrationRepository } from '../../domain/repositories/integration.repository';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { PrismaService } from './prisma.service';
import { clientOf } from './prisma-client';

@Injectable()
export class PrismaIntegrationRepository extends IntegrationRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }
  async create(userId: string, name: string, tx?: TransactionHandle) {
    return clientOf(this.prisma, tx).integration.create({ data: { userId, name } });
  }
  async findOwned(id: string, userId: string, tx?: TransactionHandle) {
    return clientOf(this.prisma, tx).integration.findFirst({ where: { id, userId } });
  }
  async list(userId: string) {
    const rows = await this.prisma.integration.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { _count: { select: { items: { where: { kind: 'DOCUMENT', deletedAt: null } } } } },
    });
    return rows.map(({ _count, ...row }) => ({ ...row, documentCount: _count.items }));
  }
  async revoke(id: string, now: Date, tx?: TransactionHandle): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.integration.update({ where: { id }, data: { revokedAt: now } });
    await client.apiToken.updateMany({
      where: { integrationId: id, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
