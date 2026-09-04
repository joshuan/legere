import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { AppConfig } from '../config/app-config';

// Graceful shutdown waits for active jobs, capped so a stuck job cannot block exit (docs/06 §6.8).
const STOP_TIMEOUT_MS = 30_000;

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
      // 🔒 The server never migrates its schema. pg-boss begins every migration plan with
      // `CREATE SCHEMA IF NOT EXISTS`, which requires database-wide CREATE even when `pgboss`
      // already exists. The owner-only queue-migrate one-shot runs first; runtime only checks the
      // version. The same owner-only step also creates/updates every fixed application queue, so
      // runtime needs neither schema DDL nor EXECUTE on pg-boss's DDL helpers (SEC-43, docs/12 §12.7).
      migrate: false,
    });

    // pg-boss keeps working after a transient database error; without a listener the emitted error
    // would be an unhandled event and take the process down.
    boss.on('error', () => undefined);

    await boss.start();

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
