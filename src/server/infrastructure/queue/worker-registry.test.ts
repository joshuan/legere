import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySettingsRepository } from '../../../../test/helpers/processing-fakes';
import type { JobHandler } from '../../application/jobs/job-handler';
import type { QueueName } from '../../application/ports/job-queue';
import { QueueSettings, ungatedServices } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
import { FixedClock } from '../../../../test/helpers/fakes';
import { AppConfig } from '../config/app-config';
import { PgBossProvider } from './pg-boss.provider';
import { WorkerRegistry } from './worker-registry';

// Two handlers, so a test can pause one queue and watch the other keep working.
@Injectable()
class IngestHandler implements JobHandler {
  handle(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
class ProcessHandler implements JobHandler {
  // Takes its payload, so a test can make one job of a batch fail on what it was sent and watch
  // what becomes of the jobs delivered beside it (docs/06 §6.8).
  handle(_payload: unknown): Promise<void> {
    return Promise.resolve();
  }
}

type BatchHandler = (jobs: { id: string; data: object }[]) => Promise<void>;

// Records what pg-boss was asked to serve and to stop serving; nothing here talks to a database.
class RecordingBoss {
  readonly working: Array<{ queue: string; batchSize: number | undefined }> = [];
  readonly stopped: string[] = [];
  readonly failed: Array<{ queue: string; id: string }> = [];
  private readonly callbacks = new Map<string, BatchHandler>();

  work(queue: string, options: { batchSize?: number }, callback: BatchHandler): Promise<string> {
    this.working.push({ queue, batchSize: options.batchSize });
    this.callbacks.set(queue, callback);
    return Promise.resolve('worker-id');
  }

  fail(queue: string, id: string): Promise<void> {
    this.failed.push({ queue, id });
    return Promise.resolve();
  }

  // What pg-boss's own wrapper does with the batch: run it, and complete every id in it unless the
  // callback threw, in which case it fails every id in it.
  async deliver(queue: string, jobs: { id: string; data: object }[]): Promise<string[]> {
    const callback = this.callbacks.get(queue);
    if (callback === undefined) throw new Error(`No worker for ${queue}`);
    try {
      await callback(jobs);
      // `complete` only touches rows still active, so a job this run already failed is skipped.
      const alreadyFailed = new Set(this.failed.map((entry) => entry.id));
      return jobs.map((job) => job.id).filter((id) => !alreadyFailed.has(id));
    } catch {
      return [];
    }
  }

  offWork(queue: string): Promise<void> {
    this.stopped.push(queue);
    return Promise.resolve();
  }

  get queues(): string[] {
    return this.working.map((entry) => entry.queue);
  }

  reset(): void {
    this.working.length = 0;
    this.stopped.length = 0;
    this.failed.length = 0;
  }
}

// Which queues have a worker, and how many jobs each takes at once (docs/05 §5.4, docs/11 §11.13).
describe('WorkerRegistry', () => {
  let boss: RecordingBoss;
  let store: InMemorySettingsRepository;
  let registry: WorkerRegistry;
  let gates: ServiceGates;
  let processHandler: ProcessHandler;

  beforeEach(async () => {
    boss = new RecordingBoss();
    store = new InMemorySettingsRepository();
    gates = new ServiceGates(new FixedClock());

    const testing = await Test.createTestingModule({
      providers: [
        WorkerRegistry,
        IngestHandler,
        ProcessHandler,
        { provide: ServiceGates, useValue: gates },
        { provide: PgBossProvider, useValue: { start: () => Promise.resolve(boss) } },
        { provide: AppConfig, useValue: { get: () => undefined } },
        {
          provide: QueueSettings,
          useValue: new QueueSettings(store, {
            concurrency: {
              'library-scan': 1,
              'file-ingest': 4,
              'document-process': 2,
              maintenance: 1,
            },
            unitConcurrency: 1,
            services: ungatedServices(),
          }),
        },
        {
          provide: getLoggerToken(WorkerRegistry.name),
          useValue: { info: () => {}, error: () => {} },
        },
      ],
    }).compile();

    registry = testing.get(WorkerRegistry);
    processHandler = testing.get(ProcessHandler);
    registry.register(
      { queue: 'file-ingest', handler: IngestHandler },
      { queue: 'document-process', handler: ProcessHandler },
    );
  });

  async function pause(...queues: QueueName[]): Promise<void> {
    await store.write('queue', { paused: queues });
  }

  it('serves every registered queue with the stored concurrency', async () => {
    await registry.start();

    expect(boss.queues).toEqual(['file-ingest', 'document-process']);
    expect(boss.working.map((entry) => entry.batchSize)).toEqual([4, 2]);
  });

  it('registers no worker for a paused queue and leaves the others working', async () => {
    await pause('document-process');

    await registry.start();

    // 🔒 Nothing consumes the paused queue; jobs sent to it stay where they can be seen
    // (docs/05 §5.4).
    expect(boss.queues).toEqual(['file-ingest']);
  });

  it('applies a pause on restart, without stopping the instance', async () => {
    await registry.start();
    expect(boss.queues).toEqual(['file-ingest', 'document-process']);

    await pause('document-process');
    boss.reset();
    await registry.restart();

    // Every queue is told to stop, and only the ones that are not paused come back.
    expect(boss.stopped).toEqual(['file-ingest', 'document-process']);
    expect(boss.queues).toEqual(['file-ingest']);
  });

  it('brings a resumed queue back on the next restart', async () => {
    await pause('file-ingest', 'document-process');
    await registry.start();
    expect(boss.queues).toEqual([]);

    await store.write('queue', { paused: [] });
    boss.reset();
    await registry.restart();

    expect(boss.queues).toEqual(['file-ingest', 'document-process']);
  });

  it('reconfigures only the named queue and reports what is actually registered', async () => {
    await registry.start();
    boss.reset();

    await registry.reconfigure(['document-process'], {
      concurrency: {
        'library-scan': 1,
        'file-ingest': 4,
        'document-process': 7,
        maintenance: 1,
      },
      paused: [],
    });

    expect(boss.stopped).toEqual(['document-process']);
    expect(boss.working).toEqual([{ queue: 'document-process', batchSize: 7 }]);
    expect(registry.snapshot()).toEqual(
      expect.arrayContaining([
        { queue: 'file-ingest', registered: true, appliedConcurrency: 4 },
        { queue: 'document-process', registered: true, appliedConcurrency: 7 },
        { queue: 'maintenance', registered: false, appliedConcurrency: null },
      ]),
    );
  });

  // The gates of docs/05 §5.4b come from the same row as the concurrencies, and are applied at the
  // same moment: an instance that was started with a gate stored is gated from its first job.
  it('configures the service gates from the settings it registers workers from', async () => {
    await store.write('queue', { services: { stirling: { concurrency: 2, cooldownSeconds: 30 } } });
    const configure = vi.spyOn(gates, 'configure');

    await registry.start();

    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({
        stirling: { concurrency: 2, cooldownSeconds: 30 },
        // Everything else stays as the environment left it, which is ungated.
        docling: { concurrency: 0, cooldownSeconds: 0 },
      }),
    );
  });

  it('ignores a paused name for a queue it does not serve', async () => {
    await store.write('queue', { paused: ['thumbnails'] });

    await registry.start();

    expect(boss.queues).toEqual(['file-ingest', 'document-process']);
  });

  // 🔒 One job's outcome is its own (docs/05 §5.4e, docs/06 §6.8). pg-boss's wrapper completes or
  // fails **every id in the batch** on the callback's one outcome, so a document that met a
  // container which was down used to take its healthy neighbour down with it — and the neighbour's
  // retry is a fresh OCR pass, a fresh parse, a transcription and two analyst completions, during
  // exactly the outage §5.4e exists to make cheap.
  it('fails only the job that failed, and leaves its neighbours in the batch completed', async () => {
    vi.spyOn(processHandler, 'handle').mockImplementation((payload: unknown) => {
      const data: Record<string, unknown> = { ...(payload ?? {}) };
      return data.poisoned === true
        ? Promise.reject(new Error('docling is unreachable'))
        : Promise.resolve();
    });
    await registry.start();

    const completed = await boss.deliver('document-process', [
      { id: 'healthy-1', data: {} },
      { id: 'poisoned', data: { poisoned: true } },
      { id: 'healthy-2', data: {} },
    ]);

    expect(boss.failed).toEqual([{ queue: 'document-process', id: 'poisoned' }]);
    expect(completed).toEqual(['healthy-1', 'healthy-2']);
  });
});
