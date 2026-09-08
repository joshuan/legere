import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { moneyValueSchema } from '../../../shared/contracts/document-fields';
import {
  DEFAULT_RECEIPT_SORT,
  receiptExtractionSchema,
  type ReceiptExtraction,
  type ReceiptSort,
} from '../../../shared/contracts/receipts';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Receipt } from '../../domain/entities/receipt';
import type { Viewer } from '../../domain/repositories/document.repository';
import {
  ReceiptRepository,
  type ReceiptListInput,
  type ReceiptProcessingUpdate,
} from '../../domain/repositories/receipt.repository';
import { decodeReceiptCursor, encodeReceiptCursor, type ReceiptCursor } from './cursor';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

const RECEIPT_INCLUDE = {
  file: true,
  archiveItem: { include: { createdBy: { select: { id: true, displayName: true } } } },
} satisfies Prisma.ReceiptInclude;

type ReceiptRow = Prisma.ReceiptGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

function toDomain(row: ReceiptRow): Receipt {
  const owner = row.archiveItem.createdBy;
  if (owner === null) throw new Error(`Receipt ${row.id} has no owner`);
  const extracted = receiptExtractionSchema.safeParse(row.extracted);
  return {
    id: row.id,
    fileId: row.fileId,
    file: {
      id: row.file.id,
      contentHash: row.file.contentHash,
      origin: row.file.origin,
      storageKey: row.file.storageKey,
      mimeType: row.file.mimeType,
      ext: row.file.ext,
      sizeBytes: row.file.sizeBytes,
      name: row.file.name,
      pageCount: row.file.pageCount,
      trashedAt: row.file.trashedAt,
      trashedReason: row.file.trashedReason,
      trashedFrom: row.file.trashedFrom,
      trashedArchiveKind: row.file.trashedArchiveKind,
      trashedOwnerId: row.file.trashedOwnerId,
      replacedById: row.file.replacedById,
      createdAt: row.file.createdAt,
      updatedAt: row.file.updatedAt,
      deletedAt: row.file.deletedAt,
    },
    pageCount: row.pageCount,
    previewStatus: row.previewStatus,
    extractionStatus: row.extractionStatus,
    extracted: extracted.success ? extracted.data : null,
    sourceText: row.sourceText,
    processingError: row.processingError,
    failedStep: row.failedStep,
    createdById: owner.id,
    createdAt: row.archiveItem.createdAt,
    updatedAt: row.archiveItem.updatedAt,
    lastEventAt: row.archiveItem.lastEventAt,
    deletedAt: row.archiveItem.deletedAt,
    owner,
  };
}

function readableBy(viewer: Viewer): Prisma.ArchiveItemWhereInput {
  return viewer.role === 'ADMIN' ? {} : { createdById: viewer.id };
}

const RECEIPT_ORDER_BY: Record<ReceiptSort, Prisma.ReceiptOrderByWithRelationInput[]> = {
  // An unprocessed or unreadable date is not newer than a date printed on a receipt. Keeping NULL
  // last is also what prevents a fresh upload from jumping to the top of the default shelf.
  purchasedAt: [{ purchasedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
  createdAt: [{ archiveItem: { createdAt: 'desc' } }, { id: 'desc' }],
  // Deliberately compares the printed numbers without converting their currencies (docs/15 §15.7).
  total: [{ totalAmount: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
};

function cursorKeyOf(sort: ReceiptSort, row: ReceiptRow): string | null {
  switch (sort) {
    case 'purchasedAt':
      return row.purchasedAt?.toISOString().slice(0, 10) ?? null;
    case 'createdAt':
      return row.archiveItem.createdAt.toISOString();
    case 'total':
      return row.totalAmount === null ? null : String(row.totalAmount);
  }
}

function cursorFilter(cursor: ReceiptCursor): Prisma.ReceiptWhereInput {
  switch (cursor.sort) {
    case 'createdAt': {
      const createdAt = new Date(cursor.key ?? '');
      return {
        OR: [
          { archiveItem: { createdAt: { lt: createdAt } } },
          { archiveItem: { createdAt }, id: { lt: cursor.id } },
        ],
      };
    }
    case 'purchasedAt': {
      if (cursor.key === null) return { purchasedAt: null, id: { lt: cursor.id } };
      const purchasedAt = new Date(`${cursor.key}T00:00:00.000Z`);
      return {
        OR: [
          { purchasedAt: { lt: purchasedAt } },
          { purchasedAt, id: { lt: cursor.id } },
          { purchasedAt: null },
        ],
      };
    }
    case 'total': {
      if (cursor.key === null) return { totalAmount: null, id: { lt: cursor.id } };
      const totalAmount = Number(cursor.key);
      return {
        OR: [
          { totalAmount: { lt: totalAmount } },
          { totalAmount, id: { lt: cursor.id } },
          { totalAmount: null },
        ],
      };
    }
  }
}

function listFilters(query: ReceiptListInput): Prisma.ReceiptWhereInput {
  return {
    ...(query.q === undefined
      ? {}
      : { vendor: { contains: query.q, mode: 'insensitive' as const } }),
    ...(query.purchasedFrom === undefined && query.purchasedTo === undefined
      ? {}
      : {
          purchasedAt: {
            ...(query.purchasedFrom === undefined
              ? {}
              : { gte: new Date(`${query.purchasedFrom}T00:00:00.000Z`) }),
            ...(query.purchasedTo === undefined
              ? {}
              : { lte: new Date(`${query.purchasedTo}T00:00:00.000Z`) }),
          },
        }),
    ...(query.country === undefined ? {} : { country: query.country }),
    ...(query.currency === undefined ? {} : { currency: query.currency }),
    ...(query.amountMin === undefined && query.amountMax === undefined
      ? {}
      : {
          totalAmount: {
            ...(query.amountMin === undefined ? {} : { gte: query.amountMin }),
            ...(query.amountMax === undefined ? {} : { lte: query.amountMax }),
          },
        }),
  };
}

function projectionOf(extracted: ReceiptExtraction | null): {
  vendor: string | null;
  purchasedAt: Date | null;
  country: string | null;
  currency: string | null;
  totalAmount: number | null;
} {
  const values = extracted?.values;
  const vendor = values?.['vendor'];
  const purchasedAt = values?.['purchasedAt'];
  const country = values?.['country'];
  const total = moneyValueSchema.safeParse(values?.['total']);
  const parsedPurchaseDate =
    typeof purchasedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(purchasedAt)
      ? new Date(`${purchasedAt}T00:00:00.000Z`)
      : null;
  return {
    vendor: typeof vendor === 'string' ? vendor : null,
    purchasedAt:
      parsedPurchaseDate !== null &&
      !Number.isNaN(parsedPurchaseDate.getTime()) &&
      parsedPurchaseDate.toISOString().slice(0, 10) === purchasedAt
        ? parsedPurchaseDate
        : null,
    country: typeof country === 'string' ? country : null,
    currency: total.success ? total.data.currency : null,
    totalAmount: total.success ? total.data.amount : null,
  };
}

@Injectable()
export class PrismaReceiptRepository extends ReceiptRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(
    input: { fileId: string; createdById: string; sourceText?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<Receipt> {
    const client = clientOf(this.prisma, tx);
    const archiveItem = await client.archiveItem.create({
      data: { kind: 'RECEIPT', createdById: input.createdById },
    });
    const row = await client.receipt.create({
      data: {
        id: archiveItem.id,
        fileId: input.fileId,
        ...(input.sourceText === undefined ? {} : { sourceText: input.sourceText }),
      },
      include: RECEIPT_INCLUDE,
    });
    return toDomain(row);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Receipt | null> {
    const row = await clientOf(this.prisma, tx).receipt.findUnique({
      where: { id },
      include: RECEIPT_INCLUDE,
    });
    return row === null ? null : toDomain(row);
  }

  async findReadableById(
    id: string,
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<Receipt | null> {
    const row = await clientOf(this.prisma, tx).receipt.findFirst({
      where: { id, archiveItem: { deletedAt: null, ...readableBy(viewer) } },
      include: RECEIPT_INCLUDE,
    });
    return row === null ? null : toDomain(row);
  }

  async findByFileId(fileId: string, tx?: TransactionHandle): Promise<Receipt | null> {
    const row = await clientOf(this.prisma, tx).receipt.findUnique({
      where: { fileId },
      include: RECEIPT_INCLUDE,
    });
    return row === null ? null : toDomain(row);
  }

  async list(
    viewer: Viewer,
    query: ReceiptListInput,
    tx?: TransactionHandle,
  ): Promise<{ items: Receipt[]; nextCursor: string | null }> {
    const sort = query.sort ?? DEFAULT_RECEIPT_SORT;
    const cursor = decodeReceiptCursor(query.cursor, sort);
    const rows = await clientOf(this.prisma, tx).receipt.findMany({
      where: {
        AND: [
          { archiveItem: { deletedAt: null, ...readableBy(viewer) } },
          listFilters(query),
          ...(cursor === null ? [] : [cursorFilter(cursor)]),
        ],
      },
      include: RECEIPT_INCLUDE,
      orderBy: RECEIPT_ORDER_BY[sort],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toDomain),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeReceiptCursor({ sort, key: cursorKeyOf(sort, last), id: last.id })
          : null,
    };
  }

  async updateProcessing(
    id: string,
    update: ReceiptProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Receipt> {
    const client = clientOf(this.prisma, tx);
    if (update.extracted !== undefined) {
      const json = update.extracted === null ? null : JSON.stringify(update.extracted);
      const projection = projectionOf(update.extracted);
      await client.$executeRaw`
        UPDATE receipts
           SET extracted = CASE WHEN ${json}::text IS NULL THEN NULL ELSE ${json}::jsonb END,
               vendor = ${projection.vendor},
               purchased_at = ${projection.purchasedAt},
               country = ${projection.country},
               currency = ${projection.currency},
               total_amount = ${projection.totalAmount}
         WHERE id = ${id}::uuid`;
    }
    const row = await client.receipt.update({
      where: { id },
      data: {
        ...(update.previewStatus === undefined ? {} : { previewStatus: update.previewStatus }),
        ...(update.extractionStatus === undefined
          ? {}
          : { extractionStatus: update.extractionStatus }),
        ...(update.pageCount === undefined ? {} : { pageCount: update.pageCount }),
        ...(update.processingError === undefined
          ? {}
          : { processingError: update.processingError }),
        ...(update.failedStep === undefined ? {} : { failedStep: update.failedStep }),
      },
      include: RECEIPT_INCLUDE,
    });
    await client.archiveItem.update({ where: { id }, data: { updatedAt: new Date() } });
    return toDomain(row);
  }

  async filterExistingIds(ids: string[], tx?: TransactionHandle): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).receipt.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async softDelete(id: string, at: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).archiveItem.updateMany({
      where: { id, kind: 'RECEIPT', deletedAt: null },
      data: { deletedAt: at },
    });
  }

  async hardDelete(id: string, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).archiveItem.deleteMany({ where: { id, kind: 'RECEIPT' } });
  }
}
