import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { QUEUE_NAMES, type QueueName } from '../../application/ports/job-queue';
import { AppConfig } from '../config/app-config';

// Retry policy shared by every queue (docs/06 §6.8).
export const RETRY_LIMIT = 5;
export const EXPIRE_IN_HOURS = 2;

// Graceful shutdown waits for active jobs, capped so a stuck job cannot block exit (docs/06 §6.8).
const STOP_TIMEOUT_MS = 30_000;

// Queues whose work is keyed by an entity get pg-boss's `stately` policy: at most one job queued and
// at most one active per singleton key. That is what makes "one scan per library at a time" and
// "one merge per scan set" hold at the database level (docs/05 §5.2, §5.4, docs/06 §6.8) — a plain
// singletonKey on the default `standard` policy does not deduplicate at all.
const SINGLETON_QUEUES: ReadonlySet<QueueName> = new Set(['library-scan', 'scanset-merge']);

// Owns the single PgBoss instance for the process (docs/06 §6.8): one connection pool on
// DATABASE_URL, its own `pgboss` schema, which Prisma does not manage (docs/04 §4.2).
@Injectable()
export class PgBossProvider implements OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;

  constructor(private readonly config: AppConfig) {}

  // Idempotent: concurrent callers share one start, so bootstrap and an early enqueue cannot race
  // into two instances.
  start(): Promise<PgBoss> {
    this.starting ??= this.createAndStart();
    return this.starting;
  }

  // Null until started — the monitor uses this to report the queue as down rather than starting it.
  current(): PgBoss | null {
    return this.boss;
  }

  private async createAndStart(): Promise<PgBoss> {
    const boss = new PgBoss({
      connectionString: this.config.get('DATABASE_URL'),
      schema: 'pgboss',
    });

    // pg-boss keeps working after a transient database error; without a listener the emitted error
    // would be an unhandled event and take the process down.
    boss.on('error', () => undefined);

    await boss.start();

    // v10 requires a queue to exist before send/work touches it. createQueue leaves an existing
    // queue untouched, so the options are applied again with updateQueue — otherwise an instance
    // created by an earlier version would keep its old policy and retry settings forever.
    for (const name of QUEUE_NAMES) {
      const options = {
        name,
        policy: SINGLETON_QUEUES.has(name) ? ('stately' as const) : ('standard' as const),
        retryLimit: RETRY_LIMIT,
        retryBackoff: true,
        expireInHours: EXPIRE_IN_HOURS,
      };
      await boss.createQueue(name, options);
      await boss.updateQueue(name, options);
    }

    this.boss = boss;
    return boss;
  }

  async onApplicationShutdown(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    this.starting = null;
    if (boss === null) return;
    await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS }).catch(() => undefined);
  }
}
