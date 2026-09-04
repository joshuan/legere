import PgBoss from 'pg-boss';
import { QUEUE_NAMES } from '../src/server/application/ports/job-queue';
import {
  EXPIRE_IN_SECONDS,
  policyOf,
  RETRY_LIMIT,
} from '../src/server/infrastructure/queue/pg-boss-policy';

// pg-boss owns a schema Prisma cannot migrate. This executable is the queue equivalent of
// `prisma migrate deploy`: a short-lived process with the database owner credential, run before the
// runtime role is provisioned and before the server starts (SEC-43, docs/12 §12.7).
async function migrateQueue(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is required to migrate the pg-boss schema');
  }

  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (error: Error) => {
    process.stderr.write(`pg-boss migration: ${error.message}\n`);
  });
  await boss.start();

  // pg-boss v10 requires queues (and their partitions) to exist before runtime can send/work.
  // This owner-only executable owns that DDL too: a compromised long-lived process cannot create
  // unbounded partitions through create_queue. updateQueue makes code-owned options converge on
  // every deploy rather than preserving an earlier release's policy indefinitely.
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

  await boss.stop({ graceful: true, timeout: 30_000 });
}

void migrateQueue().catch((error: unknown) => {
  process.stderr.write(
    `pg-boss migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exitCode = 1;
});
