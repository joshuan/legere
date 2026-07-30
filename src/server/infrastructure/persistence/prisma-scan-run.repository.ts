import { Injectable } from '@nestjs/common';
import { Prisma, type ScanRun as PrismaScanRun } from '@prisma/client';
import type { ScanRunStatus } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  ScanRunRepository,
  type ScanRun,
  type ScanRunCounters,
  type ScanRunPage,
} from '../../domain/repositories/scan-run.repository';
import { clientOf } from './prisma-client';
import { decodeCursor, encodeCursor } from './cursor';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaScanRun): ScanRun {
  return {
    id: row.id,
    libraryId: row.libraryId,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    filesSeen: row.filesSeen,
    filesNew: row.filesNew,
    filesChanged: row.filesChanged,
    filesMissing: row.filesMissing,
    error: row.error,
  };
}

@Injectable()
export class PrismaScanRunRepository implements ScanRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Relies on scan_runs_running_uq (docs/04 §4.3) instead of checking first: a unique-violation is
  // the only way to be sure no second RUNNING row slipped in concurrently.
  async startRun(libraryId: string, tx?: TransactionHandle): Promise<ScanRun | null> {
    try {
      const row = await clientOf(this.prisma, tx).scanRun.create({
        data: { libraryId, status: 'RUNNING' },
      });
      return toDomain(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return null;
      }
      throw error;
    }
  }

  async findRunning(libraryId: string, tx?: TransactionHandle): Promise<ScanRun | null> {
    const row = await clientOf(this.prisma, tx).scanRun.findFirst({
      where: { libraryId, status: 'RUNNING' },
    });
    return row === null ? null : toDomain(row);
  }

  async findById(id: string, tx?: TransactionHandle): Promise<ScanRun | null> {
    const row = await clientOf(this.prisma, tx).scanRun.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async finish(
    id: string,
    status: Extract<ScanRunStatus, 'DONE' | 'FAILED'>,
    counters: ScanRunCounters,
    finishedAt: Date,
    error: string | null,
    tx?: TransactionHandle,
  ): Promise<void> {
    await clientOf(this.prisma, tx).scanRun.update({
      where: { id },
      data: { status, finishedAt, error, ...counters },
    });
  }

  // Keyset pagination on (startedAt, id) descending — newest first (docs/07 §7.3).
  async listForLibrary(
    libraryId: string,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<ScanRunPage> {
    const cursor = decodeCursor(query.cursor);
    const rows = await clientOf(this.prisma, tx).scanRun.findMany({
      where: {
        libraryId,
        ...(cursor === null
          ? {}
          : {
              OR: [
                { startedAt: { lt: cursor.at } },
                { startedAt: cursor.at, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ at: last.startedAt, id: last.id })
        : null;

    return { items: page.map(toDomain), nextCursor };
  }

  // One row per library — the newest run — via DISTINCT ON, so the admin table needs a single query
  // rather than one per library.
  async latestForLibraries(
    libraryIds: string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, ScanRun>> {
    if (libraryIds.length === 0) return new Map();

    const rows = await clientOf(this.prisma, tx).$queryRaw<PrismaScanRun[]>`
      SELECT DISTINCT ON (library_id)
             id, library_id AS "libraryId", status, started_at AS "startedAt",
             finished_at AS "finishedAt", files_seen AS "filesSeen", files_new AS "filesNew",
             files_changed AS "filesChanged", files_missing AS "filesMissing", error
      FROM scan_runs
      WHERE library_id = ANY(${libraryIds}::uuid[])
      ORDER BY library_id, started_at DESC
    `;

    return new Map(rows.map((row) => [row.libraryId, toDomain(row)]));
  }
}
