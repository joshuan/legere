import { Injectable } from '@nestjs/common';
import type { FileRef as PrismaFileRef } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { FileRef } from '../../domain/entities/file-ref';
import {
  FileRefRepository,
  type CreateFileRefInput,
  type FileRefSnapshot,
} from '../../domain/repositories/file-ref.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
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
    documentId: row.documentId,
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
        documentId: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      size: row.size,
      mtimeMs: row.mtime.getTime(),
      status: row.status,
      contentHash: row.contentHash,
      documentId: row.documentId,
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

  // Back to DISCOVERED with the new size/mtime; the previous hash and document stay until ingest
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
    documentId: string,
    size: bigint,
    mtimeMs: number,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).fileRef.update({
      where: { id },
      data: {
        status: 'HASHED',
        contentHash,
        documentId,
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

  async findLiveRefForDocument(
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<FileRef | null> {
    const row = await clientOf(this.prisma, tx).fileRef.findFirst({
      where: { documentId, status: 'HASHED', library: { deletedAt: null } },
      // Oldest first, so repeated runs read the same copy of duplicated content.
      orderBy: { firstSeenAt: 'asc' },
    });
    return row === null ? null : toDomain(row);
  }

  countLiveRefsInActiveLibraries(documentId: string, tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).fileRef.count({
      where: {
        documentId,
        status: 'HASHED',
        library: { deletedAt: null },
      },
    });
  }
}
