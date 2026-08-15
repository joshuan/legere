import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { OrderedPair } from '../../domain/entities/document-link';
import {
  DocumentLinkRepository,
  type DocumentLinkEdge,
} from '../../domain/repositories/document-link.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

// The edges between documents (docs/03 §3.3.23): pair-unique, hard-deleted, cascading with a
// hard-deleted document. Pairs arrive already ordered — the domain's `orderedPair` is the one
// place that spelling is decided.
@Injectable()
export class PrismaDocumentLinkRepository implements DocumentLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForDocument(documentId: string, tx?: TransactionHandle): Promise<DocumentLinkEdge[]> {
    const rows = await clientOf(this.prisma, tx).documentLink.findMany({
      where: { OR: [{ aId: documentId }, { bId: documentId }] },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      otherDocumentId: row.aId === documentId ? row.bId : row.aId,
      linkedAt: row.createdAt,
    }));
  }

  async exists(pair: OrderedPair, tx?: TransactionHandle): Promise<boolean> {
    const row = await clientOf(this.prisma, tx).documentLink.findUnique({
      where: { aId_bId: { aId: pair.aId, bId: pair.bId } },
      select: { id: true },
    });
    return row !== null;
  }

  async create(
    pair: OrderedPair,
    createdById: string | null,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).documentLink.create({
      data: { aId: pair.aId, bId: pair.bId, createdById, createdAt: at },
    });
  }

  async remove(pair: OrderedPair, tx?: TransactionHandle): Promise<boolean> {
    const removed = await clientOf(this.prisma, tx).documentLink.deleteMany({
      where: { aId: pair.aId, bId: pair.bId },
    });
    return removed.count > 0;
  }
}
