import PgBoss from 'pg-boss';
import { QUEUE_NAMES } from '../src/server/application/ports/job-queue';
import {
  EXPIRE_IN_SECONDS,
  policyOf,
  RETRY_LIMIT,
} from '../src/server/infrastructure/queue/pg-boss-policy';

// pg-boss owns a schema Prisma cannot migrate. This executable is the queue equivalent of
// `prisma migrate deploy`: image startup runs it after Prisma and before the server, using the same
// DATABASE_URL in Docker, Compose and every other container runtime (docs/12 §12.6–12.7).
export async function migrateQueue(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is required to migrate the pg-boss schema');
  }

  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (error: Error) => {
    process.stderr.write(`pg-boss migration: ${error.message}\n`);
  });
  try {
    await boss.start();

    // pg-boss v10 requires queues (and their partitions) to exist before runtime can send/work.
    // updateQueue makes code-owned options converge on every start rather than preserving an earlier
    // release's policy indefinitely.
    for (const name of QUEUE_NAMES) {
      const options = {
        name,
        policy: policyOf(name),
        retryLimit: RETRY_LIMIT,
        retryBackoff: true,
        expireInSeconds: EXPIRE_IN_SECONDS[name],
      };
      await boss.createQueue(name, options);
      await boss.updateQueue(name, options);
    }
  } finally {
    // A rejected migration must release its pool and timers too; otherwise the failed one-shot
    // keeps the container alive indefinitely and the application's startup never completes.
    await boss.stop({ graceful: true, timeout: 30_000 });
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  void migrateQueue().catch((error: unknown) => {
    process.stderr.write(
      `pg-boss migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    // pg-boss v10 does not close a pool when start() fails before its started flag is set.
    // This is a failed one-shot, so terminate even if that partially opened pool holds handles.
    process.exit(1);
  });
}
