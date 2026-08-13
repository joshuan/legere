import { Injectable } from '@nestjs/common';
import type { FileRef as PrismaFileRef } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { FileRef } from '../../domain/entities/file-ref';
import {
  FileRefRepository,
  type CreateFileRefInput,
  type FileRefSnapshot,
  type FolderSummary,
} from '../../domain/repositories/file-ref.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { folderPrefixPattern } from './like';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaFileRef): FileRef {
  return {
    id: row.id,
    libraryId: row.libraryId,
    path: RelativePath.tryParse(row.path) ?? RelativePath.root(),
    size: row.size,
    // Stored as timestamptz; the scan compares whole milliseconds (docs/05 §5.2).
    mtimeMs: row.mtime.getTime(),
    status: row.status,
    contentHash: row.contentHash,
    fileId: row.fileId,
    missingSince: row.missingSince,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

@Injectable()
export class PrismaFileRefRepository implements FileRefRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<FileRef | null> {
    const row = await clientOf(this.prisma, tx).fileRef.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findByPath(
    libraryId: string,
    path: RelativePath,
    tx?: TransactionHandle,
  ): Promise<FileRef | null> {
    const row = await clientOf(this.prisma, tx).fileRef.findUnique({
      where: { libraryId_path: { libraryId, path: path.value } },
    });
    return row === null ? null : toDomain(row);
  }

  async snapshotForLibrary(libraryId: string, tx?: TransactionHandle): Promise<FileRefSnapshot[]> {
    const rows = await clientOf(this.prisma, tx).fileRef.findMany({
      where: { libraryId },
      select: {
        id: true,
        path: true,
        size: true,
        mtime: true,
        status: true,
        contentHash: true,
        fileId: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      size: row.size,
      mtimeMs: row.mtime.getTime(),
      status: row.status,
      contentHash: row.contentHash,
      fileId: row.fileId,
    }));
  }

  async create(input: CreateFileRefInput, tx?: TransactionHandle): Promise<FileRef> {
    const row = await clientOf(this.prisma, tx).fileRef.create({
      data: {
        libraryId: input.libraryId,
        path: input.path.value,
        size: input.size,
        mtime: new Date(input.mtimeMs),
        status: 'DISCOVERED',
        firstSeenAt: input.seenAt,
        lastSeenAt: input.seenAt,
      },
    });
    return toDomain(row);
  }

  // Back to DISCOVERED with the new size/mtime; the previous hash and file stay until ingest
  // replaces them, so the document remains reachable while the re-hash is pending.
  async markDiscovered(
    id: string,
    size: bigint,
    mtimeMs: number,
    seenAt: Date,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).fileRef.update({
      where: { id },
      data: {
        status: 'DISCOVERED',
        size,
        mtime: new Date(mtimeMs),
        lastSeenAt: seenAt,
        // A returned file is no longer missing.
        missingSince: null,
      },
    });
  }

  async markHashed(
    id: string,
    contentHash: string,
    fileId: string,
    size: bigint,
    mtimeMs: number,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).fileRef.update({
      where: { id },
      data: {
        status: 'HASHED',
        contentHash,
        fileId,
        size,
        mtime: new Date(mtimeMs),
        missingSince: null,
      },
    });
  }

  async touchSeen(ids: string[], seenAt: Date, tx?: TransactionHandle): Promise<void> {
    if (ids.length === 0) return;
    await clientOf(this.prisma, tx).fileRef.updateMany({
      where: { id: { in: ids } },
      data: { lastSeenAt: seenAt },
    });
  }

  // missingSince is only set on refs that were not already missing, so the original disappearance
  // time survives repeated scans (docs/05 §5.7).
  async markMissing(ids: string[], missingSince: Date, tx?: TransactionHandle): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await clientOf(this.prisma, tx).fileRef.updateMany({
      where: { id: { in: ids }, status: { not: 'MISSING' } },
      data: { status: 'MISSING', missingSince },
    });
    return result.count;
  }

  async markExcluded(fileIds: readonly string[], tx?: TransactionHandle): Promise<void> {
    if (fileIds.length === 0) return;
    await clientOf(this.prisma, tx).fileRef.updateMany({
      where: { fileId: { in: [...fileIds] } },
      // `contentHash`, `size` and `mtime` stay: the exclusion is about these bytes at this path, and
      // the scan compares all three before it decides the path is spoken for (docs/03 §3.3.9).
      // `fileId` cannot stay — the file row is deleted a statement later.
      data: { status: 'EXCLUDED', fileId: null },
    });
  }

  // Folders are derived, not stored (docs/11 §11.4): the distinct next path segment of every ref
  // below `folder`, counted by the documents underneath. A ref points at a file and the file at a
  // document (docs/03 §3.3.16), so the count travels through `document_files`. Raw SQL because the
  // shape of the answer is a string operation on the path, which the query builder cannot express.
  async listFoldersUnder(
    libraryId: string,
    folder: string,
    tx?: TransactionHandle,
  ): Promise<FolderSummary[]> {
    // 🔒 The pattern is escaped, the offset counts the folder itself — see `folderPrefixPattern`.
    const below = folderPrefixPattern(folder);
    const rows = await clientOf(this.prisma, tx).$queryRaw<{ name: string; count: bigint }[]>`
      WITH below AS (
        SELECT df.document_id,
               CASE
                 WHEN ${folder} = '' THEN f.path
                 ELSE substring(f.path from char_length(${folder}) + 2)
               END AS rel
        FROM file_refs f
        JOIN document_files df ON df.file_id = f.file_id
        JOIN documents d ON d.id = df.document_id AND d.deleted_at IS NULL
        WHERE f.library_id = ${libraryId}::uuid
          AND (${folder} = '' OR f.path LIKE ${below} ESCAPE '\\')
      )
      SELECT split_part(rel, '/', 1) AS name, count(DISTINCT document_id) AS count
      FROM below
      WHERE position('/' in rel) > 0
      GROUP BY 1
      ORDER BY 1
    `;

    return rows.map((row) => ({ name: row.name, documentCount: Number(row.count) }));
  }

  async findLiveRefForFile(fileId: string, tx?: TransactionHandle): Promise<FileRef | null> {
    const row = await clientOf(this.prisma, tx).fileRef.findFirst({
      where: { fileId, status: 'HASHED', library: { deletedAt: null } },
      // Oldest first, so repeated runs read the same copy of duplicated content.
      orderBy: { firstSeenAt: 'asc' },
    });
    return row === null ? null : toDomain(row);
  }
}
