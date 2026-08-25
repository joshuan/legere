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
      -- 🔒 Counted in two passes rather than over one join. A ref points at a file and a page of a
      -- document at the file (docs/03 §3.3.17), and since ADR-025 one file may be read by many
      -- pages — so joining the pages here would count every ref once per page of it and report a
      -- library as holding ten times the files it holds.
      WITH scoped AS (
        SELECT fr.library_id, fr.status, fr.file_id
        FROM file_refs fr
        WHERE fr.library_id = ANY(${libraryIds}::uuid[])
      ), counted AS (
        SELECT library_id,
               count(*) FILTER (WHERE status <> 'MISSING') AS files,
               count(*) FILTER (WHERE status = 'MISSING')  AS missing
        FROM scoped
        GROUP BY library_id
      ), read_by AS (
        SELECT s.library_id, count(DISTINCT dp.document_id) AS documents
        FROM scoped s
        JOIN document_pages dp ON dp.file_id = s.file_id
        GROUP BY s.library_id
      )
      SELECT c.library_id,
             c.files,
             c.missing,
             COALESCE(r.documents, 0) AS documents
      FROM counted c
      LEFT JOIN read_by r ON r.library_id = c.library_id
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
