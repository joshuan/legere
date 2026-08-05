import { Injectable } from '@nestjs/common';
import { Prisma, type File as PrismaFile } from '@prisma/client';
import { cropSchema, type Crop } from '../../../shared/contracts/documents';
import type { ValueSource } from '../../../shared/contracts/enums';
import { artifactKeys } from '../../application/storage/artifact-keys';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { File } from '../../domain/entities/file';
import { ConflictError } from '../../domain/errors/domain-error';
import {
  FileRepository,
  type CreateFileInput,
  type DocumentFile,
} from '../../domain/repositories/file.repository';
import { clientOf, isPrismaTx } from './prisma-client';
import type { PrismaTx } from './prisma-unit-of-work';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaFile): File {
  return {
    id: row.id,
    contentHash: row.contentHash,
    origin: row.origin,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    ext: row.ext,
    sizeBytes: row.sizeBytes,
    name: row.name,
    crop: toCrop(row.crop),
    cropSource: row.cropSource,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

// The column is jsonb, so what comes back is `unknown` as far as types go: parse it rather than
// trusting it. A crop that cannot be read is no crop — the file is still a file, and the canonical
// is rebuilt from the whole image instead of failing.
function toCrop(value: unknown): Crop | null {
  const parsed = cropSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// A JSON column set to `null` must become SQL NULL rather than the JSON literal `null`, which is a
// different value and would read back as "a crop nobody can parse".
function toCropColumn(crop: Crop | null): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return crop === null ? Prisma.DbNull : { points: crop.points };
}

// The columns a unique violation names, so a P2002 can be attributed to the index that raised it.
// Empty rather than null when Prisma reports nothing: the violation happened, we just cannot say
// which constraint it was.
function uniqueViolationColumns(error: unknown): string[] | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = error.meta?.['target'];
  if (typeof target === 'string') return [target];
  if (!Array.isArray(target)) return [];
  return target.filter((column): column is string => typeof column === 'string');
}

// 🔒 document_files_file_id_key — the file already has a home (docs/03 §3.3.16). The compound
// primary key (document_id, position) names other columns, so the two are told apart rather than
// both reported as a conflict.
function isFileHomeViolation(error: unknown): boolean {
  const columns = uniqueViolationColumns(error);
  return columns !== null && columns.some((column) => column.includes('file_id'));
}

@Injectable()
export class PrismaFileRepository implements FileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<File | null> {
    const row = await clientOf(this.prisma, tx).file.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findActiveByContentHash(contentHash: string, tx?: TransactionHandle): Promise<File | null> {
    const row = await clientOf(this.prisma, tx).file.findFirst({
      where: { contentHash, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async findOrCreateByContentHash(
    input: CreateFileInput,
    tx?: TransactionHandle,
  ): Promise<{ file: File; created: boolean }> {
    const existing = await this.findActiveByContentHash(input.contentHash, tx);
    if (existing !== null) return { file: existing, created: false };

    try {
      const row = await clientOf(this.prisma, tx).file.create({
        data: {
          contentHash: input.contentHash,
          origin: input.origin,
          storageKey: input.storageKey,
          mimeType: input.mimeType,
          ext: input.ext,
          sizeBytes: input.sizeBytes,
          name: input.name,
        },
      });

      // A managed file's key is `files/{id}/original.{ext}`, and the id only exists once the row
      // does — so it is written back here rather than guessed by the caller. The column is what
      // docs/09 §9.2 promises will keep resolving after the layout changes, so it must not stay
      // empty for the files written under the current one.
      if (row.origin === 'MANAGED' && row.storageKey === null) {
        const storageKey = artifactKeys.fileOriginal(row.id, row.ext);
        const withKey = await clientOf(this.prisma, tx).file.update({
          where: { id: row.id },
          data: { storageKey },
        });
        return { file: toDomain(withKey), created: true };
      }

      return { file: toDomain(row), created: true };
    } catch (error) {
      // files_content_hash_active_uq (docs/04 §4.3): another ingest inserted the same bytes between
      // the read above and this write. Whoever lost simply uses the winner, so identical content
      // still yields exactly one file (ADR-009 one level down, ADR-021).
      if (uniqueViolationColumns(error) !== null) {
        const winner = await this.findActiveByContentHash(input.contentHash, tx);
        if (winner !== null) return { file: winner, created: false };
      }
      throw error;
    }
  }

  async setCrop(
    id: string,
    crop: Crop | null,
    cropSource: ValueSource,
    tx?: TransactionHandle,
  ): Promise<File> {
    const row = await clientOf(this.prisma, tx).file.update({
      where: { id },
      data: { crop: toCropColumn(crop), cropSource },
    });
    return toDomain(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).file.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }

  // --- the composition of a document -------------------------------------------------------

  async listForDocument(documentId: string, tx?: TransactionHandle): Promise<DocumentFile[]> {
    const rows = await clientOf(this.prisma, tx).documentFile.findMany({
      where: { documentId },
      include: { file: true },
      orderBy: { position: 'asc' },
    });
    return rows.map((row) => ({ ...toDomain(row.file), position: row.position }));
  }

  // One query for a whole page: the list needs a count, an extension and a weight per row, and a
  // query per document would be a query per row (docs/03 §3.3.10).
  async listForDocuments(
    documentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, DocumentFile[]>> {
    const byDocument = new Map<string, DocumentFile[]>(documentIds.map((id) => [id, []]));
    if (documentIds.length === 0) return byDocument;

    const rows = await clientOf(this.prisma, tx).documentFile.findMany({
      where: { documentId: { in: [...documentIds] } },
      include: { file: true },
      orderBy: [{ documentId: 'asc' }, { position: 'asc' }],
    });

    for (const row of rows) {
      const files = byDocument.get(row.documentId);
      if (files === undefined) continue;
      files.push({ ...toDomain(row.file), position: row.position });
    }
    return byDocument;
  }

  // A soft-deleted document keeps its files rather than releasing them (docs/03 §3.3.10), so this
  // answers with the home a file has, deleted or not — which is what stops the next scan from
  // ingesting a file whose document an admin removed on purpose.
  async findDocumentIdForFile(fileId: string, tx?: TransactionHandle): Promise<string | null> {
    const row = await clientOf(this.prisma, tx).documentFile.findUnique({
      where: { fileId },
      select: { documentId: true },
    });
    return row === null ? null : row.documentId;
  }

  async attach(documentId: string, fileId: string, tx?: TransactionHandle): Promise<void> {
    const client = clientOf(this.prisma, tx);

    // Asked before inserting rather than only caught afterwards: a failed statement poisons the
    // surrounding transaction, and the caller of `attach` is usually inside one.
    const home = await client.documentFile.findUnique({ where: { fileId } });
    if (home !== null) throw fileAlreadyInDocument();

    const last = await client.documentFile.aggregate({
      where: { documentId },
      _max: { position: true },
    });

    try {
      // Appended at the end, keeping positions contiguous and 0-based (docs/03 §3.3.17).
      await client.documentFile.create({
        data: { documentId, fileId, position: (last._max.position ?? -1) + 1 },
      });
    } catch (error) {
      // 🔒 The same file arriving twice at once: whoever lost the race is told it has a home
      // (docs/07 §7.2). A collision on (document_id, position) is a different index and stays an
      // error, because two appends racing is a retry the caller must decide about.
      if (isFileHomeViolation(error)) throw fileAlreadyInDocument();
      throw error;
    }
  }

  async detach(documentId: string, fileId: string, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).documentFile.deleteMany({ where: { documentId, fileId } });
  }

  // Wholesale, because position is part of the primary key: shifting rows one at a time collides
  // with itself halfway through (docs/03 §3.3.17). Delete-then-insert in one transaction is the
  // only rewrite that cannot deadlock against its own intermediate state.
  async reorder(
    documentId: string,
    fileIdsInOrder: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const rewrite = async (client: PrismaTx): Promise<void> => {
      await client.documentFile.deleteMany({ where: { documentId } });
      if (fileIdsInOrder.length === 0) return;
      await client.documentFile.createMany({
        data: fileIdsInOrder.map((fileId, position) => ({ documentId, fileId, position })),
      });
    };

    if (tx !== undefined && isPrismaTx(tx)) {
      await rewrite(tx);
      return;
    }
    await this.prisma.$transaction(rewrite);
  }

  // Availability for a whole page in one query (docs/03 §3.3.10): every file asked about is in the
  // answer, with zero for the ones no volume holds any more.
  async countLiveRefsForFiles(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>(fileIds.map((id) => [id, 0]));
    if (fileIds.length === 0) return counts;

    const rows = await clientOf(this.prisma, tx).fileRef.groupBy({
      by: ['fileId'],
      where: { fileId: { in: [...fileIds] }, status: 'HASHED', library: { deletedAt: null } },
      _count: { _all: true },
    });

    for (const row of rows) {
      if (row.fileId === null) continue;
      counts.set(row.fileId, row._count._all);
    }
    return counts;
  }
}

function fileAlreadyInDocument(): ConflictError {
  return new ConflictError(
    'FILE_ALREADY_IN_DOCUMENT',
    'This file already belongs to another document',
  );
}
