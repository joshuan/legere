import { Injectable, type Type } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import type PgBoss from 'pg-boss';
import type { JobWithMetadata } from 'pg-boss';
import type { QueueSettingsDto } from '../../../shared/contracts/queue';
import type { JobHandler } from '../../application/jobs/job-handler';
import { ServiceUnavailableError } from '../../application/ports/service-unavailable';
import { QUEUE_NAMES, type QueueName } from '../../application/ports/job-queue';
import {
  ProcessingWorkerRuntime,
  type ProcessingWorkerState,
} from '../../application/ports/processing-worker-runtime';
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
export class WorkerRegistry extends ProcessingWorkerRuntime {
  private readonly bindings: WorkerBinding[] = [];
  private readonly applied = new Map<QueueName, number>();
  private readonly slots = new Map<QueueName, WorkerSlots>();

  constructor(
    private readonly provider: PgBossProvider,
    private readonly moduleRef: ModuleRef,
    private readonly config: AppConfig,
    private readonly settings: QueueSettings,
    private readonly gates: ServiceGates,
    @InjectPinoLogger(WorkerRegistry.name) private readonly logger: PinoLogger,
  ) {
    super();
  }

  // Feature modules register their handlers; bootstrap starts them all in one place.
  register(...bindings: WorkerBinding[]): void {
    this.bindings.push(...bindings);
  }

  async start(): Promise<void> {
    const boss = await this.provider.start();
    const settings = await this.settings.read();
    // The same read that decides how many workers each queue gets also decides how many calls each
    // external service may be doing at once (docs/05 §5.4b): both are "how hard this instance
    // works", and both are stored in the one settings row.
    this.gates.configure(settings.services);

    for (const binding of this.bindings) await this.startOne(boss, binding, settings);
  }

  // Applying a new setting without a restart: pg-boss is told to stop serving each queue, and the
  // workers are registered again with the numbers that are now stored (docs/11 §11.13). An admin
  // changing a knob should not have to bounce the container to see it take effect. This is also
  // what pausing and resuming are: a queue that is now paused simply gets no worker back.
  async restart(): Promise<void> {
    const settings = await this.settings.read();
    this.gates.configure(settings.services);
    await this.reconfigure(
      this.bindings.map(({ queue }) => queue),
      settings,
    );
  }

  // Apply only the queues whose controls changed. If this throws, ProcessingControlPlane invokes it
  // again with the previous desired settings as compensation; calling it is therefore idempotent.
  async reconfigure(
    queues: readonly QueueName[],
    settings: Pick<QueueSettingsDto, 'concurrency' | 'paused'>,
  ): Promise<void> {
    const selected = new Set(queues);
    if (selected.size === 0) return;
    const boss = await this.provider.start();

    for (const binding of this.bindings) {
      if (!selected.has(binding.queue)) continue;
      await boss.offWork(binding.queue);
      this.applied.delete(binding.queue);
    }
    for (const binding of this.bindings) {
      if (selected.has(binding.queue)) await this.startOne(boss, binding, settings);
    }
  }

  snapshot(): ProcessingWorkerState[] {
    return QUEUE_NAMES.map((queue) => ({
      queue,
      registered: this.applied.has(queue),
      appliedConcurrency: this.applied.get(queue) ?? null,
    }));
  }

  async scheduleSystemCrons(): Promise<void> {
    const boss = await this.provider.start();
    await boss.schedule('maintenance', MAINTENANCE_CRON, {});
  }

  private async startOne(
    boss: PgBoss,
    binding: WorkerBinding,
    settings: Pick<QueueSettingsDto, 'concurrency' | 'paused'>,
  ): Promise<void> {
    if (settings.paused.includes(binding.queue)) {
      this.applied.delete(binding.queue);
      this.logger.info({ queue: binding.queue }, 'Queue is paused, no worker started');
      return;
    }

    // The resolved settings are the control plane's truth for every queue. A binding-level value is
    // retained only as a fallback for a deliberately partial test double.
    const concurrency = settings.concurrency[binding.queue] ?? binding.concurrency ?? 1;
    const handler = this.moduleRef.get<JobHandler>(binding.handler, { strict: false });
    const slots = this.slots.get(binding.queue) ?? new WorkerSlots();
    this.slots.set(binding.queue, slots);
    slots.resize(concurrency);
    // Each subscriber refills independently. Shared slots also bound draining subscribers during
    // reconfiguration: pg-boss offWork stops polling but does not await their current callbacks.
    for (let index = 0; index < concurrency; index += 1) {
      await boss.work(
        binding.queue,
        { batchSize: 1, includeMetadata: true },
        async (jobs: JobWithMetadata<object>[]): Promise<void> => {
          await Promise.all(
            jobs.map((job) => slots.run(() => this.runOne(boss, binding.queue, job, handler))),
          );
        },
      );
    }
    this.applied.set(binding.queue, concurrency);
    this.logger.info({ queue: binding.queue, concurrency }, 'Queue worker started');
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
    job: JobWithMetadata<object>,
    handler: JobHandler,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const output: Record<string, unknown> = { ...job.output };
      await handler.handle(job.data, {
        retryCount: job.retryCount ?? 0,
        resumeFromCheckpoint: output.resumeFromCheckpoint === true,
      });
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
      await boss
        .fail(queue, job.id, {
          message: messageOf(error),
          ...(queue === 'document-process' && error instanceof ServiceUnavailableError
            ? { resumeFromCheckpoint: true }
            : {}),
        })
        .catch(() => {
          throw error;
        });
    }
  }
}

class WorkerSlots {
  private limit = 1;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  resize(limit: number): void {
    this.limit = limit;
    this.admit();
  }

  async run(work: () => Promise<void>): Promise<void> {
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      this.admit();
    });
    try {
      await work();
    } finally {
      this.active -= 1;
      this.admit();
    }
  }

  private admit(): void {
    while (this.active < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) break;
      this.active += 1;
      next();
    }
  }
}

// What pg-boss stores as the job's output. The same shape its own wrapper writes, so the failures
// screen reads a job this failed exactly as it reads one the wrapper failed (docs/11 §11.13).
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
