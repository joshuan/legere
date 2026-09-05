import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { QUEUE_NAMES } from '../../application/ports/job-queue';
import {
  QueueMonitor,
  type FailedJobWork,
  type FailedJobPage,
  type QueueDepth,
} from '../../application/ports/queue-monitor';
import { PrismaService } from '../persistence/prisma.service';
import { PgBossProvider } from './pg-boss.provider';

const FAILED_WINDOW = '24 hours';
const COMPLETED_WINDOW = '1 hour';
const DEFAULT_PAGE_SIZE = 30;

type DepthRow = {
  name: string;
  queued: bigint;
  active: bigint;
  failed_recent: bigint;
  oldest_queued_at: Date | null;
  last_completed_at: Date | null;
  completed_last_hour: bigint;
};
type FailedRow = {
  id: string;
  name: string;
  data: unknown;
  output: unknown;
  completed_on: Date | null;
  retry_count: number;
};

// Reads pg-boss's own tables directly (docs/06 §6.3.3): the admin view needs aggregates pg-boss's
// client API does not expose, and Prisma does not model that schema (docs/04 §4.2).
@Injectable()
export class PgBossQueueMonitor extends QueueMonitor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PgBossProvider,
  ) {
    super();
  }

  async depths(): Promise<QueueDepth[]> {
    // One scan and one row per application queue. Completed rows are deliberately retained in the
    // input: they are the evidence for liveness, while each FILTER keeps them out of queue depth.
    const rows = await this.prisma.$queryRaw<DepthRow[]>`
      SELECT name,
        count(*) FILTER (WHERE state IN ('created', 'retry')) AS queued,
        count(*) FILTER (WHERE state = 'active') AS active,
        count(*) FILTER (
          WHERE state = 'failed' AND completed_on > now() - ${FAILED_WINDOW}::interval
        ) AS failed_recent,
        min(created_on) FILTER (WHERE state IN ('created', 'retry')) AS oldest_queued_at,
        max(completed_on) FILTER (WHERE state = 'completed') AS last_completed_at,
        count(*) FILTER (
          WHERE state = 'completed' AND completed_on > now() - ${COMPLETED_WINDOW}::interval
        ) AS completed_last_hour
      FROM pgboss.job
      WHERE name IN (${Prisma.join(QUEUE_NAMES)})
      GROUP BY name
    `;

    const byQueue = new Map(rows.map((row) => [row.name, row]));

    return QUEUE_NAMES.map((name) => {
      const row = byQueue.get(name);
      return {
        name,
        queued: Number(row?.queued ?? 0),
        active: Number(row?.active ?? 0),
        failedRecent: Number(row?.failed_recent ?? 0),
        oldestQueuedAt: row?.oldest_queued_at?.toISOString() ?? null,
        lastCompletedAt: row?.last_completed_at?.toISOString() ?? null,
        completedLastHour: Number(row?.completed_last_hour ?? 0),
      };
    });
  }

  // Keyset pagination on completed_on: failures are read newest-first and the cursor is the
  // timestamp of the last row returned.
  async failedJobs(cursor?: string, limit = DEFAULT_PAGE_SIZE): Promise<FailedJobPage> {
    const before = parseCursor(cursor);
    const take = Math.min(Math.max(limit, 1), 100);

    const rows = await this.prisma.$queryRaw<FailedRow[]>`
      SELECT id::text AS id, name, data, output, completed_on, retry_count
      FROM pgboss.job
      WHERE state = 'failed'
        AND (${before}::timestamptz IS NULL OR completed_on < ${before}::timestamptz)
      ORDER BY completed_on DESC
      LIMIT ${take + 1}
    `;

    const page = rows.slice(0, take);
    const last = page.at(-1);
    const nextCursor =
      rows.length > take && last?.completed_on != null ? last.completed_on.toISOString() : null;

    return {
      items: page.map((row) => ({
        jobId: row.id,
        queue: row.name,
        payload: row.data,
        error: describeError(row.output),
        failedAt: (row.completed_on ?? new Date(0)).toISOString(),
        retryCount: row.retry_count,
      })),
      nextCursor,
    };
  }

  // A point read of the immutable journal row. This adapter never revives or copies it; the
  // application layer validates its queue and sends a new job through the policy-aware JobQueue.
  async failedJob(jobId: string): Promise<FailedJobWork | null> {
    const rows = await this.prisma.$queryRaw<{ name: string; data: unknown }[]>`
      SELECT name, data FROM pgboss.job WHERE id = ${jobId}::uuid AND state = 'failed'
    `;
    const job = rows[0];
    return job === undefined ? null : { queue: job.name, payload: job.data };
  }

  async isHealthy(): Promise<boolean> {
    if (this.provider.current() === null) return false;
    try {
      await this.prisma.$queryRaw`SELECT 1 FROM pgboss.version LIMIT 1`;
      return true;
    } catch {
      return false;
    }
  }
}

// 🔒 The contract has already refused a cursor that is not a timestamp, with a 422 naming the field
// (docs/07 §7.1). This is the second check, and it exists because the first one is a schema on a
// route: an `Invalid Date` reaching `${before}::timestamptz` is a driver error — a 500 for what was
// only ever a malformed query parameter — so nothing but a real date leaves this function.
function parseCursor(cursor: string | undefined): Date | null {
  if (cursor === undefined) return null;
  const at = new Date(cursor);
  return Number.isNaN(at.getTime()) ? null : at;
}

// pg-boss stores the thrown value in `output`; surface a readable message without leaking a stack.
function describeError(output: unknown): string {
  if (typeof output === 'string') return output;
  if (typeof output === 'object' && output !== null) {
    if ('message' in output && typeof output.message === 'string') return output.message;
    if ('value' in output && typeof output.value === 'string') return output.value;
  }
  return 'Unknown error';
}
