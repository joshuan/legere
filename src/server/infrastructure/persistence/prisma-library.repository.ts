import { Injectable } from '@nestjs/common';
import type { Library as PrismaLibrary } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Library } from '../../domain/entities/library';
import {
  LibraryRepository,
  type CreateLibraryInput,
  type LibraryCounts,
  type UpdateLibraryInput,
} from '../../domain/repositories/library.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaLibrary): Library {
  return {
    id: row.id,
    name: row.name,
    // Stored paths were validated on the way in; a row that somehow holds an invalid path reads as
    // the volume root rather than crashing a listing.
    rootPath: RelativePath.tryParse(row.rootPath) ?? RelativePath.root(),
    enabled: row.enabled,
    visibility: row.visibility,
    scanIntervalMinutes: row.scanIntervalMinutes,
    excludeGlobs: row.excludeGlobs,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class PrismaLibraryRepository implements LibraryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<Library | null> {
    const row = await clientOf(this.prisma, tx).library.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async listActive(tx?: TransactionHandle): Promise<Library[]> {
    const rows = await clientOf(this.prisma, tx).library.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toDomain);
  }

  // ALL_USERS plus the caller's explicit grants; disabled libraries stay visible, since disabling
  // only stops scanning (docs/03 §3.3.6).
  async listVisibleTo(userId: string, tx?: TransactionHandle): Promise<Library[]> {
    const rows = await clientOf(this.prisma, tx).library.findMany({
      where: {
        deletedAt: null,
        OR: [{ visibility: 'ALL_USERS' }, { access: { some: { userId } } }],
      },
      orderBy: { name: 'asc' },
    });
    return rows.map(toDomain);
  }

  async create(input: CreateLibraryInput, tx?: TransactionHandle): Promise<Library> {
    const row = await clientOf(this.prisma, tx).library.create({
      data: {
        name: input.name,
        rootPath: input.rootPath.value,
        visibility: input.visibility,
        scanIntervalMinutes: input.scanIntervalMinutes,
        excludeGlobs: input.excludeGlobs,
      },
    });
    return toDomain(row);
  }

  async update(id: string, input: UpdateLibraryInput, tx?: TransactionHandle): Promise<Library> {
    const row = await clientOf(this.prisma, tx).library.update({ where: { id }, data: input });
    return toDomain(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).library.update({ where: { id }, data: { deletedAt } });
  }

  // Three counters in one pass per library: live files, distinct documents behind them, and files
  // whose original has gone missing (docs/07 §7.3).
  async countsFor(libraryIds: string[], tx?: TransactionHandle): Promise<LibraryCounts[]> {
    if (libraryIds.length === 0) return [];

    const rows = await clientOf(this.prisma, tx).$queryRaw<
      { library_id: string; files: bigint; documents: bigint; missing: bigint }[]
    >`
      SELECT fr.library_id,
             count(*) FILTER (WHERE fr.status <> 'MISSING')              AS files,
             -- A ref points at a file, and the file is what a document holds (docs/03 §3.3.9), so
             -- "documents in this library" is one join further out than it used to be.
             count(DISTINCT df.document_id) FILTER (WHERE df.document_id IS NOT NULL) AS documents,
             count(*) FILTER (WHERE fr.status = 'MISSING')               AS missing
      FROM file_refs fr
      LEFT JOIN document_files df ON df.file_id = fr.file_id
      WHERE fr.library_id = ANY(${libraryIds}::uuid[])
      GROUP BY fr.library_id
    `;

    return rows.map((row) => ({
      libraryId: row.library_id,
      files: Number(row.files),
      documents: Number(row.documents),
      missing: Number(row.missing),
    }));
  }

  async listUserIds(libraryId: string, tx?: TransactionHandle): Promise<string[]> {
    const rows = await clientOf(this.prisma, tx).libraryAccess.findMany({
      where: { libraryId },
      select: { userId: true },
      orderBy: { userId: 'asc' },
    });
    return rows.map((row) => row.userId);
  }

  // A pure ACL with no history requirement, so revocation is a hard delete (docs/03 §3.3.7).
  async replaceUserIds(
    libraryId: string,
    userIds: string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    await client.libraryAccess.deleteMany({ where: { libraryId } });
    if (userIds.length === 0) return;

    await client.libraryAccess.createMany({
      data: [...new Set(userIds)].map((userId) => ({ libraryId, userId })),
      skipDuplicates: true,
    });
  }
}
