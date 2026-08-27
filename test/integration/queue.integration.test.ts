import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobHandler } from '../../src/server/application/jobs/job-handler';
import { JobQueue } from '../../src/server/application/ports/job-queue';
import { QueueMonitor } from '../../src/server/application/ports/queue-monitor';
import {
  UnitOfWork,
  type TransactionHandle,
} from '../../src/server/application/ports/unit-of-work';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { isPrismaTx } from '../../src/server/infrastructure/persistence/prisma-client';
import type { PrismaTx } from '../../src/server/infrastructure/persistence/prisma-unit-of-work';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { PgBossProvider } from '../../src/server/infrastructure/queue/pg-boss.provider';
import { QueueModule } from '../../src/server/infrastructure/queue/queue.module';
import { WorkerRegistry } from '../../src/server/infrastructure/queue/worker-registry';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';

// A handler that records what it received, so worker wiring and payload delivery can be observed.
class RecordingHandler extends JobHandler {
  readonly received: unknown[] = [];
  handle(payload: unknown): Promise<void> {
    this.received.push(payload);
    return Promise.resolve();
  }
}

// Integration coverage for the queue (docs/06 §6.8, docs/05 §5.4) against the real pg-boss schema.
describe('Queue (integration)', () => {
  let queue: JobQueue;
  let monitor: QueueMonitor;
  let unitOfWork: UnitOfWork;
  let prisma: PrismaService;
  let provider: PgBossProvider;
  let workers: WorkerRegistry;
  let handler: RecordingHandler;
  let close: () => Promise<void>;

  beforeAll(async () => {
    handler = new RecordingHandler();

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule,
        PersistenceModule,
        QueueModule,
      ],
      providers: [{ provide: RecordingHandler, useValue: handler }],
    }).compile();

    queue = moduleRef.get(JobQueue);
    monitor = moduleRef.get(QueueMonitor);
    unitOfWork = moduleRef.get(UnitOfWork);
    prisma = moduleRef.get(PrismaService);
    provider = moduleRef.get(PgBossProvider);
    workers = moduleRef.get(WorkerRegistry);
    close = () => moduleRef.close();

    await provider.start();
    await truncateAll();
  });

  afterEach(async () => {
    // Leave no jobs behind for the next test.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    handler.received.length = 0;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE pgboss.job').catch(() => undefined);
    await close();
    await disconnectTestPrisma();
  });

  type JobRow = { name: string; state: string; singletonkey: string | null; data: unknown };

  const jobs = (): Promise<JobRow[]> =>
    prisma.$queryRawUnsafe<JobRow[]>(
      'SELECT name, state, singleton_key AS singletonkey, data FROM pgboss.job ORDER BY created_on',
    );

  it('starts pg-boss in its own schema with every queue created', async () => {
    // pg-boss keeps internal queues of its own (__pgboss__*); only ours are asserted.
    const rows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM pgboss.queue WHERE name NOT LIKE '__pgboss__%' ORDER BY name",
    );

    expect(rows.map((row) => row.name)).toEqual([
      'document-process',
      'file-ingest',
      'library-scan',
      'maintenance',
    ]);
  });

  it('gives each queue its own expiry, so a dead worker blocks it for minutes and not hours', async () => {
    const rows = await prisma.$queryRawUnsafe<{ name: string; seconds: number }[]>(
      `SELECT name, expire_seconds AS seconds
       FROM pgboss.queue WHERE name NOT LIKE '__pgboss__%'`,
    );
    const byName = new Map(rows.map((row) => [row.name, Number(row.seconds)]));

    // 🔒 The singleton queues are the ones that hurt: an abandoned job keeps its key, so this is how
    // long a library stays unscannable after a restart mid-scan (docs/06 §6.8).
    expect(byName.get('library-scan')).toBe(15 * 60);
    expect(byName.get('file-ingest')).toBe(10 * 60);
    // 🔒 And `document-process` is above the sum of its own step budgets rather than under it
    // (docs/05 §5.4a). pg-boss does not cancel a handler that outruns its expiry — it fails the job
    // and delivers another copy while the first is still running — so an expiry below the work is a
    // second run of the same document every hour. The §5.4a arithmetic is 165 minutes; this is
    // three hours.
    expect(byName.get('document-process')).toBe(3 * 60 * 60);
    for (const seconds of byName.values()) expect(seconds).toBeLessThanOrEqual(3 * 60 * 60);
  });

  // 🔒 A key deduplicates only on a queue whose policy says it does (docs/06 §6.8). `document-process`
  // was created `standard`, so the keys three call sites already passed collapsed nothing and a loop
  // of cheap composition edits queued one full pipeline run each.
  it('debounces document-process by the work asked for, and leaves the other queues alone', async () => {
    const rows = await prisma.$queryRawUnsafe<{ name: string; policy: string }[]>(
      "SELECT name, policy FROM pgboss.queue WHERE name NOT LIKE '__pgboss__%' ORDER BY name",
    );
    const byName = new Map(rows.map((row) => [row.name, row.policy]));

    expect(byName.get('document-process')).toBe('short');
    expect(byName.get('library-scan')).toBe('stately');
    expect(byName.get('file-ingest')).toBe('standard');
    expect(byName.get('maintenance')).toBe('standard');
  });

  it('enqueues a job with its payload', async () => {
    const id = await queue.enqueue('file-ingest', { fileRefId: 'abc' });

    expect(id).not.toBeNull();
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('file-ingest');
    expect(rows[0]?.data).toEqual({ fileRefId: 'abc' });
  });

  it('collapses repeated enqueues that share a singleton key', async () => {
    // One scan per library at a time (docs/05 §5.2, docs/06 §6.8).
    const first = await queue.enqueue(
      'library-scan',
      { libraryId: 'lib-1' },
      { singletonKey: 'lib-1' },
    );
    const second = await queue.enqueue(
      'library-scan',
      { libraryId: 'lib-1' },
      { singletonKey: 'lib-1' },
    );
    const other = await queue.enqueue(
      'library-scan',
      { libraryId: 'lib-2' },
      { singletonKey: 'lib-2' },
    );

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(other).not.toBeNull();

    const rows = await jobs();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.singletonkey).sort()).toEqual(['lib-1', 'lib-2']);
  });

  // 🔒 The flood SEC-50 is about (docs/05 §5.4). Every composition edit enqueues a full run at user
  // priority and none of them passed a key, so a loop of `PATCH /documents/:id/pages` — a few
  // hundred bytes, always a valid request — queued one canonical rebuild, OCR pass, Docling parse,
  // transcription and two analyst completions per request, ahead of every other document.
  it('collapses a burst of rebuilds of one document into a single queued run', async () => {
    const documentId = '11111111-1111-4111-8111-111111111111';

    const sent = [];
    for (let index = 0; index < 20; index += 1) {
      sent.push(await queue.enqueue('document-process', { documentId }, { priority: 10 }));
    }

    expect(sent.filter((id) => id !== null)).toHaveLength(1);
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.singletonkey).toBe(documentId);
  });

  // 🔒 …and the key is the document *and what is being asked about it* (docs/06 §6.8). Under a
  // debounce keyed by the document alone, a rebuild asked for by a crop would be silently not
  // created because a pending one-step job already held the key — and the crop would never appear.
  it('keeps a rebuild and a one-step run of the same document apart', async () => {
    const documentId = '22222222-2222-4222-8222-222222222222';

    const rebuild = await queue.enqueue('document-process', { documentId });
    const fields = await queue.enqueue('document-process', { documentId, steps: ['fields'] });
    const againstOrder = await queue.enqueue('document-process', {
      documentId,
      steps: ['fields'],
    });
    const inFull = await queue.enqueue('document-process', { documentId, analyseInFull: true });

    expect(rebuild).not.toBeNull();
    expect(fields).not.toBeNull();
    // The same steps of the same document asked for twice is one piece of work.
    expect(againstOrder).toBeNull();
    // Being asked to read a long document whole is different work from the run that would skip it.
    expect(inFull).not.toBeNull();

    const rows = await jobs();
    expect(rows.map((row) => row.singletonkey).sort()).toEqual([
      documentId,
      `${documentId}#fields`,
      `${documentId}#full`,
    ]);
  });

  describe('enqueueAfterTx', () => {
    it('commits the job together with the entity write', async () => {
      await unitOfWork.run(async (tx) => {
        await categoryWriter(tx).documentType.create({
          data: { slug: 'queued-together', name: 'Together' },
        });
        await queue.enqueueAfterTx(tx, 'document-process', { documentId: 'doc-1' });
      });

      const rows = await jobs();
      expect(rows).toHaveLength(1);
      // The payload has to survive the transactional path intact: a handler that receives an empty
      // object cannot tell which document it was sent for.
      expect(rows[0]?.data).toEqual({ documentId: 'doc-1' });
      expect(await prisma.documentType.count({ where: { slug: 'queued-together' } })).toBe(1);
    });

    it('keeps the payload when the send also carries queue options', async () => {
      // What "Scan now" does (docs/05 §5.2): one keyed job, at user priority, in the same
      // transaction as the ScanRun row.
      await unitOfWork.run(async (tx) => {
        await categoryWriter(tx).documentType.create({ data: { slug: 'keyed', name: 'Keyed' } });
        await queue.enqueueAfterTx(
          tx,
          'library-scan',
          { libraryId: 'lib-7', scanRunId: 'run-7' },
          { singletonKey: 'lib-7', priority: 10 },
        );
      });

      const rows = await jobs();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.data).toEqual({ libraryId: 'lib-7', scanRunId: 'run-7' });
      expect(rows[0]?.singletonkey).toBe('lib-7');
    });

    it('discards the job when the transaction rolls back', async () => {
      await expect(
        unitOfWork.run(async (tx) => {
          await categoryWriter(tx).documentType.create({
            data: { slug: 'rolled-back', name: 'Rollback' },
          });
          await queue.enqueueAfterTx(tx, 'document-process', { documentId: 'doc-2' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // 🔒 The core guarantee of docs/06 §6.3.4: no orphan job for an entity that never existed.
      expect(await jobs()).toHaveLength(0);
      expect(await prisma.documentType.count({ where: { slug: 'rolled-back' } })).toBe(0);
    });
  });

  it('runs a registered worker against a DI-resolved handler', async () => {
    workers.register({ queue: 'maintenance', handler: RecordingHandler, concurrency: 1 });
    await workers.start();

    await queue.enqueue('maintenance', { reason: 'test' });

    await waitFor(() => handler.received.length === 1);
    expect(handler.received[0]).toEqual({ reason: 'test' });
  });

  it('registers the hourly maintenance cron', async () => {
    await workers.scheduleSystemCrons();

    const rows = await prisma.$queryRawUnsafe<{ name: string; cron: string }[]>(
      "SELECT name, cron FROM pgboss.schedule WHERE name = 'maintenance'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cron).toBe('0 * * * *');
  });

  it('reports per-queue depths and a healthy queue', async () => {
    await queue.enqueue('file-ingest', { fileRefId: 'x' });
    await queue.enqueue('file-ingest', { fileRefId: 'y' });
    await queue.enqueue('document-process', { documentId: 'z' });

    const depths = await monitor.depths();
    const ingest = depths.find((depth) => depth.name === 'file-ingest');
    const process = depths.find((depth) => depth.name === 'document-process');

    expect(ingest?.queued).toBe(2);
    expect(process?.queued).toBe(1);
    // Every known queue appears, even with nothing in it.
    expect(depths).toHaveLength(4);
    expect(await monitor.isHealthy()).toBe(true);
  });

  it('lists failed jobs with their payload and error, and retries one', async () => {
    const id = await queue.enqueue('document-process', { documentId: 'fails' });
    // Mark it failed the way pg-boss records an exhausted job.
    await prisma.$executeRawUnsafe(
      `UPDATE pgboss.job SET state = 'failed', completed_on = now(),
       output = '{"message":"the canonical exploded"}'::jsonb WHERE id = $1::uuid`,
      id,
    );

    const page = await monitor.failedJobs();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      queue: 'document-process',
      error: 'the canonical exploded',
      payload: { documentId: 'fails' },
    });

    // Retrying re-enqueues a copy and leaves the original failure in the journal.
    expect(await monitor.retry(page.items[0]?.jobId ?? '')).toBe(true);
    const rows = await jobs();
    expect(rows.filter((row) => row.state === 'failed')).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'created')).toHaveLength(1);

    expect(await monitor.retry('11111111-1111-4111-8111-111111111111')).toBe(false);
  });
});

// The entity write has to go through the transaction handle, or it would not be part of what rolls
// back; tests narrow the opaque handle with the same guard repositories use.
function categoryWriter(tx: TransactionHandle): PrismaTx {
  if (!isPrismaTx(tx)) throw new Error('expected a Prisma transaction handle');
  return tx;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the queue');
}
