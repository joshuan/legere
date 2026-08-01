import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  ScanSetRepository,
  type CreateScanSetInput,
  type ScanSet,
  type ScanSetWithItems,
  type UpdateScanSetInput,
} from '../../domain/repositories/scan-set.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type Row = {
  id: string;
  name: string;
  createdById: string;
  status: ScanSet['status'];
  cropMode: ScanSet['cropMode'];
  resultDocumentId: string | null;
  error: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

type RowWithItems = Row & {
  items: {
    position: number;
    documentId: string;
    document: { title: string; mimeType: string; previewStatus: string };
  }[];
};

function toDomain(row: Row): ScanSet {
  return {
    id: row.id,
    name: row.name,
    createdById: row.createdById,
    status: row.status,
    cropMode: row.cropMode,
    resultDocumentId: row.resultDocumentId,
    error: row.error,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

function toDomainWithItems(row: RowWithItems): ScanSetWithItems {
  return {
    ...toDomain(row),
    items: row.items.map((item) => ({
      documentId: item.documentId,
      position: item.position,
      title: item.document.title,
      mimeType: item.document.mimeType,
      hasPreview: item.document.previewStatus === 'DONE',
    })),
  };
}

const ITEMS = {
  orderBy: { position: 'asc' },
  select: {
    position: true,
    documentId: true,
    document: { select: { title: true, mimeType: true, previewStatus: true } },
  },
} as const;

@Injectable()
export class PrismaScanSetRepository implements ScanSetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string, tx?: TransactionHandle): Promise<ScanSetWithItems[]> {
    const rows = await clientOf(this.prisma, tx).scanSet.findMany({
      where: { createdById: userId, deletedAt: null },
      include: { items: ITEMS },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDomainWithItems);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<ScanSetWithItems | null> {
    const row = await clientOf(this.prisma, tx).scanSet.findFirst({
      where: { id, deletedAt: null },
      include: { items: ITEMS },
    });
    return row === null ? null : toDomainWithItems(row);
  }

  async findByResultDocumentId(
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<ScanSet | null> {
    const row = await clientOf(this.prisma, tx).scanSet.findFirst({
      where: { resultDocumentId: documentId },
    });
    return row === null ? null : toDomain(row);
  }

  async create(input: CreateScanSetInput, tx?: TransactionHandle): Promise<ScanSet> {
    const row = await clientOf(this.prisma, tx).scanSet.create({
      data: { name: input.name, createdById: input.createdById, cropMode: input.cropMode },
    });
    return toDomain(row);
  }

  async update(id: string, input: UpdateScanSetInput, tx?: TransactionHandle): Promise<ScanSet> {
    const row = await clientOf(this.prisma, tx).scanSet.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.cropMode === undefined ? {} : { cropMode: input.cropMode }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.resultDocumentId === undefined
          ? {}
          : { resultDocumentId: input.resultDocumentId }),
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    });
    return toDomain(row);
  }

  // Wholesale, because position is part of the primary key: patching individual rows would collide
  // with itself halfway through a reorder (docs/03 §3.3.17).
  async replaceItems(
    scanSetId: string,
    documentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.scanSetItem.deleteMany({ where: { scanSetId } });
    if (documentIds.length === 0) return;

    await client.scanSetItem.createMany({
      data: documentIds.map((documentId, position) => ({ scanSetId, documentId, position })),
    });
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).scanSet.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }
}
