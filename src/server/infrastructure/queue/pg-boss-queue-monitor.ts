import { Injectable } from '@nestjs/common';
import { QUEUE_NAMES, type QueueName } from '../../application/ports/job-queue';
import {
  QueueMonitor,
  type FailedJobPage,
  type QueueDepth,
} from '../../application/ports/queue-monitor';
import { PrismaService } from '../persistence/prisma.service';
import { PgBossProvider } from './pg-boss.provider';

const FAILED_WINDOW = '24 hours';
const DEFAULT_PAGE_SIZE = 30;

type StateRow = { name: string; state: string; count: bigint };
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
    const rows = await this.prisma.$queryRaw<StateRow[]>`
      SELECT name, state, count(*) AS count
      FROM pgboss.job
      WHERE state IN ('created', 'retry', 'active', 'failed')
        AND (state <> 'failed' OR completed_on > now() - ${FAILED_WINDOW}::interval)
      GROUP BY name, state
    `;

    const byQueue = new Map<string, { queued: number; active: number; failedRecent: number }>();
    for (const name of QUEUE_NAMES) {
      byQueue.set(name, { queued: 0, active: 0, failedRecent: 0 });
    }

    for (const row of rows) {
      const bucket = byQueue.get(row.name);
      if (bucket === undefined) continue;
      const count = Number(row.count);
      if (row.state === 'created' || row.state === 'retry') bucket.queued += count;
      else if (row.state === 'active') bucket.active += count;
      else bucket.failedRecent += count;
    }

    return QUEUE_NAMES.map((name) => {
      const bucket = byQueue.get(name);
      return {
        name,
        queued: bucket?.queued ?? 0,
        active: bucket?.active ?? 0,
        failedRecent: bucket?.failedRecent ?? 0,
      };
    });
  }

  // Keyset pagination on completed_on: failures are read newest-first and the cursor is the
  // timestamp of the last row returned.
  async failedJobs(cursor?: string, limit = DEFAULT_PAGE_SIZE): Promise<FailedJobPage> {
    const before = cursor === undefined ? null : new Date(cursor);
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

  // Re-enqueues a copy rather than reviving the row, so the original failure stays in the journal.
  async retry(jobId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ name: string; data: unknown }[]>`
      SELECT name, data FROM pgboss.job WHERE id = ${jobId}::uuid AND state = 'failed'
    `;
    const job = rows[0];
    if (job === undefined) return false;
    if (!isQueueName(job.name)) return false;

    const boss = await this.provider.start();
    await boss.send(job.name, asPayload(job.data));
    return true;
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

function isQueueName(name: string): name is QueueName {
  return QUEUE_NAMES.some((candidate) => candidate === name);
}

function asPayload(data: unknown): object {
  return typeof data === 'object' && data !== null ? data : {};
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
