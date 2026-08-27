import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import type PgBoss from 'pg-boss';
import type { Job } from 'pg-boss';
import type { JobHandler } from '../../application/jobs/job-handler';
import type { QueueName } from '../../application/ports/job-queue';
import { QueueSettings } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
import { AppConfig } from '../config/app-config';
import { PgBossProvider } from './pg-boss.provider';

// Which handler serves which queue, and how many jobs may run at once. Handlers are resolved from
// the DI container at worker start (docs/06 §6.8), so they get their real dependencies.
export type WorkerBinding = {
  queue: QueueName;
  handler: Type<JobHandler>;
  // Omitted means 1; the ingest/process queues take their limits from config (docs/12 §12.4).
  concurrency?: number;
};

// Cron for the maintenance job (docs/06 §6.8); per-library scan schedules are registered by the
// libraries module as libraries are created and updated (M3.3).
const MAINTENANCE_CRON = '0 * * * *';

@Injectable()
export class WorkerRegistry {
  private readonly bindings: WorkerBinding[] = [];

  constructor(
    private readonly provider: PgBossProvider,
    private readonly moduleRef: ModuleRef,
    private readonly config: AppConfig,
    private readonly settings: QueueSettings,
    private readonly gates: ServiceGates,
    @InjectPinoLogger(WorkerRegistry.name) private readonly logger: PinoLogger,
  ) {}

  // Feature modules register their handlers; bootstrap starts them all in one place.
  register(...bindings: WorkerBinding[]): void {
    this.bindings.push(...bindings);
  }

  async start(): Promise<void> {
    const boss = await this.provider.start();
    const settings = await this.settings.read();
    const paused = new Set(settings.paused);
    // The same read that decides how many workers each queue gets also decides how many calls each
    // external service may be doing at once (docs/05 §5.4b): both are "how hard this instance
    // works", and both are stored in the one settings row.
    this.gates.configure(settings.services);

    for (const binding of this.bindings) {
      // 🔒 A paused queue gets no worker at all (docs/05 §5.4): jobs keep arriving and wait where
      // an admin can watch the depth grow, and nothing consumes them until it is resumed. Stopping
      // one misbehaving step must not mean stopping the instance.
      if (paused.has(binding.queue)) {
        this.logger.info({ queue: binding.queue }, 'Queue is paused, no worker started');
        continue;
      }

      const concurrency = binding.concurrency ?? settings.concurrency[binding.queue] ?? 1;
      // strict: false — handlers live in feature modules, not in this one.
      const handler = this.moduleRef.get<JobHandler>(binding.handler, { strict: false });

      await boss.work(
        binding.queue,
        { batchSize: concurrency },
        // 🔒 In parallel, which is what a concurrency of four has always claimed to mean: the batch
        // used to be awaited one job at a time, so the setting fetched four jobs and then ran them
        // in a queue of its own (docs/05 §5.4).
        async (jobs: Job<object>[]): Promise<void> => {
          await Promise.all(jobs.map((job) => this.runOne(boss, binding.queue, job, handler)));
        },
      );

      this.logger.info({ queue: binding.queue, concurrency }, 'Queue worker started');
    }
  }

  // Applying a new setting without a restart: pg-boss is told to stop serving each queue, and the
  // workers are registered again with the numbers that are now stored (docs/11 §11.13). An admin
  // changing a knob should not have to bounce the container to see it take effect. This is also
  // what pausing and resuming are: a queue that is now paused simply gets no worker back.
  async restart(): Promise<void> {
    const boss = await this.provider.start();
    for (const binding of this.bindings) {
      await boss.offWork(binding.queue);
    }
    await this.start();
  }

  async scheduleSystemCrons(): Promise<void> {
    const boss = await this.provider.start();
    await boss.schedule('maintenance', MAINTENANCE_CRON, {});
  }

  // One job at a time inside a batch, with the outcome logged per docs/06 §6.7.
  //
  // 🔒 A failure is recorded against **this** job and rethrown nowhere (docs/05 §5.4e, docs/06 §6.8).
  // pg-boss's own wrapper is `try { await callback(jobs); complete(name, jobIds) } catch { fail(name,
  // jobIds) }`, and `jobIds` is every id in the batch — so one job throwing used to fail every other
  // job delivered beside it, whatever they had finished. On `document-process` that cost an innocent
  // document a full re-run of the pipeline — a fresh OCR pass, a fresh parse, a transcription, two
  // analyst completions — because a neighbour met a container that was down, which is the opposite
  // of what §5.4e asks for during exactly that outage.
  //
  // `boss.fail` moves this one job to retry (or to failed past `RETRY_LIMIT`) with the same policy
  // the wrapper would have applied, and the wrapper's `complete` then skips it, because completion
  // only touches rows still `active`. If failing it does not land, the error is rethrown after all
  // and the old all-or-nothing behaviour stands — a job that is neither completed nor failed would
  // sit `active` until its expiry.
  private async runOne(
    boss: PgBoss,
    queue: QueueName,
    job: Job<object>,
    handler: JobHandler,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await handler.handle(job.data);
      this.logger.info(
        { job: queue, jobId: job.id, durationMs: Date.now() - startedAt, outcome: 'done' },
        'Job completed',
      );
    } catch (error) {
      this.logger.error(
        {
          job: queue,
          jobId: job.id,
          durationMs: Date.now() - startedAt,
          outcome: 'failed',
          err: error,
        },
        'Job failed',
      );
      await boss.fail(queue, job.id, { message: messageOf(error) }).catch(() => {
        throw error;
      });
    }
  }
}

// What pg-boss stores as the job's output. The same shape its own wrapper writes, so the failures
// screen reads a job this failed exactly as it reads one the wrapper failed (docs/11 §11.13).
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
