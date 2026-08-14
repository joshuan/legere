import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySettingsRepository } from '../../../../test/helpers/processing-fakes';
import type { JobHandler } from '../../application/jobs/job-handler';
import type { QueueName } from '../../application/ports/job-queue';
import { QueueSettings, ungatedServices } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
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
  handle(): Promise<void> {
    return Promise.resolve();
  }
}

// Records what pg-boss was asked to serve and to stop serving; nothing here talks to a database.
class RecordingBoss {
  readonly working: Array<{ queue: string; batchSize: number | undefined }> = [];
  readonly stopped: string[] = [];

  work(queue: string, options: { batchSize?: number }): Promise<string> {
    this.working.push({ queue, batchSize: options.batchSize });
    return Promise.resolve('worker-id');
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
  }
}

// Which queues have a worker, and how many jobs each takes at once (docs/05 §5.4, docs/11 §11.13).
describe('WorkerRegistry', () => {
  let boss: RecordingBoss;
  let store: InMemorySettingsRepository;
  let registry: WorkerRegistry;
  let gates: ServiceGates;

  beforeEach(async () => {
    boss = new RecordingBoss();
    store = new InMemorySettingsRepository();
    gates = new ServiceGates();

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
});
