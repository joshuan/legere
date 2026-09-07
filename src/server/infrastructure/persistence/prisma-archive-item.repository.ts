import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { ArchiveItemRepository } from '../../domain/repositories/archive-item.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaArchiveItemRepository extends ArchiveItemRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async documentToReceipt(
    input: { id: string; fileId: string; ownerId: string },
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.document.delete({ where: { id: input.id } });
    await client.archiveItem.update({
      where: { id: input.id },
      data: { kind: 'RECEIPT', createdById: input.ownerId, deletedAt: null },
    });
    await client.receipt.create({ data: { id: input.id, fileId: input.fileId } });
  }

  async receiptToDocument(
    input: { id: string; title: string; ownerId: string; createdAt: Date; lastEventAt: Date },
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.receipt.delete({ where: { id: input.id } });
    await client.archiveItem.update({
      where: { id: input.id },
      data: { kind: 'DOCUMENT', createdById: input.ownerId, deletedAt: null },
    });
    await client.document.create({
      data: {
        id: input.id,
        title: input.title,
        createdById: input.ownerId,
        createdAt: input.createdAt,
        lastEventAt: input.lastEventAt,
      },
    });
  }
}
