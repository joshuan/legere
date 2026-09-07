import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { receiptExtractionSchema } from '../../../shared/contracts/receipts';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Receipt } from '../../domain/entities/receipt';
import type { Viewer } from '../../domain/repositories/document.repository';
import {
  ReceiptRepository,
  type ReceiptProcessingUpdate,
} from '../../domain/repositories/receipt.repository';
import { decodeCursor, encodeCursor } from './cursor';
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
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<{ items: Receipt[]; nextCursor: string | null }> {
    const cursor = decodeCursor(query.cursor);
    const rows = await clientOf(this.prisma, tx).receipt.findMany({
      where: {
        archiveItem: {
          deletedAt: null,
          ...readableBy(viewer),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.at } },
                  { createdAt: cursor.at, id: { lt: cursor.id } },
                ],
              }),
        },
      },
      include: RECEIPT_INCLUDE,
      orderBy: [{ archiveItem: { createdAt: 'desc' } }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toDomain),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.archiveItem.createdAt, id: last.id })
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
      await client.$executeRaw`
        UPDATE receipts
           SET extracted = CASE WHEN ${json}::text IS NULL THEN NULL ELSE ${json}::jsonb END
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
