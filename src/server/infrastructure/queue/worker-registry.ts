import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import type { Job } from 'pg-boss';
import type { JobHandler } from '../../application/jobs/job-handler';
import type { QueueName } from '../../application/ports/job-queue';
import { QueueSettings } from '../../application/queue/queue-settings';
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
    @InjectPinoLogger(WorkerRegistry.name) private readonly logger: PinoLogger,
  ) {}

  // Feature modules register their handlers; bootstrap starts them all in one place.
  register(...bindings: WorkerBinding[]): void {
    this.bindings.push(...bindings);
  }

  async start(): Promise<void> {
    const boss = await this.provider.start();
    const settings = await this.settings.read();

    for (const binding of this.bindings) {
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
          await Promise.all(jobs.map((job) => this.runOne(binding.queue, job, handler)));
        },
      );

      this.logger.info({ queue: binding.queue, concurrency }, 'Queue worker started');
    }
  }

  // Applying a new setting without a restart: pg-boss is told to stop serving each queue, and the
  // workers are registered again with the numbers that are now stored (docs/11 §11.13). An admin
  // changing a knob should not have to bounce the container to see it take effect.
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

  // One job at a time inside a batch, with the outcome logged per docs/06 §6.7. Errors are rethrown
  // so pg-boss applies its retry policy instead of the job being marked complete.
  private async runOne(queue: QueueName, job: Job<object>, handler: JobHandler): Promise<void> {
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
      throw error;
    }
  }
}
