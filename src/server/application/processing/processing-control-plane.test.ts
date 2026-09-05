import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import {
  InMemoryDocumentChunkRepository,
  InMemoryDocumentRepository,
  InMemorySettingsRepository,
} from '../../../../test/helpers/processing-fakes';
import {
  PROCESSING_QUEUE_NAMES,
  processingSnapshotSchema,
} from '../../../shared/contracts/processing';
import { CheckExternalServices } from '../health/check-external-services';
import { ExternalServiceProbe, type ServiceProbeResult } from '../health/ports';
import { MetricsCache, type StorageUsage } from '../ports/metrics-cache';
import {
  ProcessingWorkerRuntime,
  type ProcessingWorkerState,
} from '../ports/processing-worker-runtime';
import {
  QueueMonitor,
  type FailedJobPage,
  type FailedJobWork,
  type QueueDepth,
} from '../ports/queue-monitor';
import { GetQueueOverview } from '../queue/inspect-queue';
import { QueueSettings, ungatedServices } from '../queue/queue-settings';
import type {
  ResumeReleasedPipelineWorkInput,
  ResumeReleasedPipelineWorkResult,
} from '../queue/resume-released-pipeline-work';
import { ServiceGates } from '../queue/service-gate';
import { ProcessingControlPlane } from './processing-control-plane';
import type { StepStatusCounters } from '../../domain/repositories/document.repository';
import type { SettingValue } from '../../domain/repositories/settings.repository';

const ZERO_COUNTS = {
  PENDING: 0,
  QUEUED: 0,
  RUNNING: 0,
  DONE: 0,
  FAILED: 0,
  SKIPPED: 0,
};

class OverviewDocuments extends InMemoryDocumentRepository {
  override countByStepStatus(): Promise<StepStatusCounters> {
    return Promise.resolve({
      total: 0,
      steps: {
        canonical: { ...ZERO_COUNTS },
        preview: { ...ZERO_COUNTS },
        markdown: { ...ZERO_COUNTS },
        analysis: { ...ZERO_COUNTS },
        fields: { ...ZERO_COUNTS },
        vectorization: { ...ZERO_COUNTS },
      },
    });
  }
}

class FailingSettingsRepository extends InMemorySettingsRepository {
  writes = 0;
  readonly failingWrites = new Set<number>();

  override write(key: string, value: SettingValue): Promise<void> {
    this.writes += 1;
    return this.failingWrites.has(this.writes)
      ? Promise.reject(new Error(`settings write ${this.writes} failed`))
      : super.write(key, value);
  }
}

class FakeQueueMonitor extends QueueMonitor {
  depths(): Promise<QueueDepth[]> {
    return Promise.resolve(
      PROCESSING_QUEUE_NAMES.map((name, index) => ({
        name,
        queued: index,
        active: 0,
        failedRecent: 0,
        oldestQueuedAt: index === 0 ? null : '2026-01-01T10:00:00.000Z',
        lastCompletedAt: '2026-01-01T11:00:00.000Z',
        completedLastHour: index + 1,
      })),
    );
  }

  failedJobs(): Promise<FailedJobPage> {
    return Promise.resolve({ items: [], nextCursor: null });
  }

  failedJob(): Promise<FailedJobWork | null> {
    return Promise.resolve(null);
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class EmptyMetrics extends MetricsCache {
  setStorageUsage(_usage: StorageUsage): void {}
  getStorageUsage(): StorageUsage | null {
    return null;
  }
}

class CountingProbe extends ExternalServiceProbe {
  calls = 0;
  check(): Promise<ServiceProbeResult> {
    this.calls += 1;
    return Promise.resolve({
      url: '',
      status: 'NOT_CONFIGURED',
      httpStatus: null,
      latencyMs: null,
      detail: null,
    });
  }
}

class FakeWorkerRuntime extends ProcessingWorkerRuntime {
  readonly calls: string[][] = [];
  failures = 0;
  private readonly applied = new Map<string, number>();

  reconfigure(
    queues: readonly (typeof PROCESSING_QUEUE_NAMES)[number][],
    settings: { concurrency: Record<string, number>; paused: string[] },
  ): Promise<void> {
    this.calls.push([...queues]);
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('pg-boss refused worker registration'));
    }
    for (const queue of queues) {
      if (settings.paused.includes(queue)) this.applied.delete(queue);
      else this.applied.set(queue, settings.concurrency[queue] ?? 1);
    }
    return Promise.resolve();
  }

  snapshot(): ProcessingWorkerState[] {
    return PROCESSING_QUEUE_NAMES.map((queue) => ({
      queue,
      registered: this.applied.has(queue),
      appliedConcurrency: this.applied.get(queue) ?? null,
    }));
  }
}

class FakeReleasedWork {
  result: ResumeReleasedPipelineWorkResult = {
    documents: 0,
    byStep: { canonical: 0, preview: 0, markdown: 0, analysis: 0, fields: 0, vectorization: 0 },
    hasMore: false,
    warnings: [],
  };
  readonly execute = vi.fn(
    (_input: ResumeReleasedPipelineWorkInput): Promise<ResumeReleasedPipelineWorkResult> =>
      Promise.resolve(this.result),
  );
}

describe('ProcessingControlPlane', () => {
  let store: FailingSettingsRepository;
  let settings: QueueSettings;
  let workers: FakeWorkerRuntime;
  let gates: ServiceGates;
  let probe: CountingProbe;
  let released: FakeReleasedWork;
  let control: ProcessingControlPlane;

  beforeEach(() => {
    const clock = new FixedClock();
    store = new FailingSettingsRepository();
    settings = new QueueSettings(store, {
      concurrency: {
        'library-scan': 1,
        'file-ingest': 4,
        'document-process': 2,
        maintenance: 1,
      },
      unitConcurrency: 1,
      services: ungatedServices(),
    });
    workers = new FakeWorkerRuntime();
    gates = new ServiceGates(clock);
    probe = new CountingProbe();
    released = new FakeReleasedWork();
    const overview = new GetQueueOverview(
      new FakeQueueMonitor(),
      new OverviewDocuments(),
      new InMemoryDocumentChunkRepository(),
      new EmptyMetrics(),
      gates,
    );
    control = new ProcessingControlPlane(
      settings,
      workers,
      gates,
      overview,
      new CheckExternalServices(probe, clock),
      released,
      { execute: () => Promise.resolve({ items: [], nextCursor: null }) },
      { execute: () => Promise.resolve({ ok: true }) },
      { execute: () => Promise.resolve({ enqueued: 0 }) },
      clock,
    );
  });

  it('returns one ordered snapshot without probing external services', async () => {
    const snapshot = await control.snapshot();

    expect(processingSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.queues.map(({ name }) => name)).toEqual(PROCESSING_QUEUE_NAMES);
    expect(snapshot.pipeline.steps.map(({ step }) => step)).toEqual([
      'canonical',
      'preview',
      'markdown',
      'analysis',
      'fields',
      'vectorization',
    ]);
    expect(snapshot.queues[1]?.runtime).toMatchObject({
      queued: 1,
      oldestQueuedAt: '2026-01-01T10:00:00.000Z',
      completedLastHour: 2,
    });
    expect(snapshot.services.every(({ health }) => health.freshness === 'UNKNOWN')).toBe(true);
    expect(probe.calls).toBe(0);
  });

  it('serializes commands and rejects the stale one under the mutation lock', async () => {
    const first = control.update(
      {
        kind: 'queue',
        queue: 'document-process',
        expectedRevision: 0,
        concurrency: 5,
      },
      'admin',
    );
    const stale = control.update(
      { kind: 'queue', queue: 'file-ingest', expectedRevision: 0, concurrency: 6 },
      'admin',
    );

    await expect(first).resolves.toMatchObject({ revision: 1, changed: true });
    await expect(stale).rejects.toMatchObject({ code: 'PROCESSING_SETTINGS_CHANGED' });
    expect(workers.calls).toEqual([['document-process']]);
  });

  it('does not touch runtime or increment the revision for a scoped no-op', async () => {
    const result = await control.update(
      { kind: 'queue', queue: 'document-process', expectedRevision: 0, paused: false },
      'admin',
    );

    expect(result).toMatchObject({ revision: 0, changed: false });
    expect(workers.calls).toEqual([]);
  });

  it('applies a service gate immediately without restarting a queue', async () => {
    await control.update(
      { kind: 'service', service: 'docling', expectedRevision: 0, concurrency: 3 },
      'admin',
    );

    const docling = (await control.snapshot()).services.find(
      ({ service }) => service === 'docling',
    );
    expect(docling?.control.concurrency).toEqual({ effective: 3, default: 0, source: 'OVERRIDE' });
    expect(docling?.gate.gated).toBe(true);
    expect(workers.calls).toEqual([]);
  });

  it('restores settings and runtime with a new revision when apply fails', async () => {
    workers.failures = 1;

    await expect(
      control.update(
        {
          kind: 'queue',
          queue: 'document-process',
          expectedRevision: 0,
          concurrency: 8,
        },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_APPLY_FAILED', details: { restored: true } });

    const state = await settings.readState();
    expect(state.revision).toBe(2);
    expect(state.controls.queues[2]?.concurrency).toEqual({
      effective: 2,
      default: 2,
      source: 'DEFAULT',
    });
    expect(workers.calls).toEqual([['document-process'], ['document-process']]);
    expect((await control.snapshot()).apply.status).toBe('APPLIED');
  });

  it('publishes DEGRADED when worker compensation fails after settings were restored', async () => {
    workers.failures = 2;

    await expect(
      control.update(
        { kind: 'queue', queue: 'file-ingest', expectedRevision: 0, paused: true },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_APPLY_FAILED', details: { restored: false } });

    const snapshot = await control.snapshot();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.apply).toMatchObject({
      status: 'DEGRADED',
      desiredRevision: 2,
      appliedRevision: null,
    });
    expect(snapshot.pipeline.steps[0]?.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'RUNTIME_DEGRADED' })]),
    );
  });

  it('still rolls gates and workers back when restoring settings itself fails', async () => {
    workers.failures = 1;
    store.failingWrites.add(2);

    await expect(
      control.update(
        { kind: 'queue', queue: 'document-process', expectedRevision: 0, concurrency: 9 },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_APPLY_FAILED', details: { restored: false } });

    expect(workers.calls).toEqual([['document-process'], ['document-process']]);
    const snapshot = await control.snapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.apply).toMatchObject({
      status: 'DEGRADED',
      desiredRevision: 1,
      appliedRevision: null,
    });
  });

  it('does not touch runtime when persistence fails before apply', async () => {
    store.failingWrites.add(1);

    await expect(
      control.update(
        { kind: 'queue', queue: 'document-process', expectedRevision: 0, concurrency: 9 },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_APPLY_FAILED', details: { restored: true } });

    expect(workers.calls).toEqual([]);
    expect((await settings.readState()).revision).toBe(0);
  });

  it('does not hide an existing degraded runtime when a later persistence attempt fails', async () => {
    workers.failures = 2;
    await expect(
      control.update(
        { kind: 'queue', queue: 'file-ingest', expectedRevision: 0, paused: true },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_APPLY_FAILED', details: { restored: false } });
    store.failingWrites.add(3);

    await expect(
      control.update(
        { kind: 'service', service: 'docling', expectedRevision: 2, concurrency: 2 },
        'admin',
      ),
    ).rejects.toMatchObject({ code: 'PROCESSING_APPLY_FAILED', details: { restored: true } });

    expect((await control.snapshot()).apply.status).toBe('DEGRADED');
  });

  it('keeps a released pause applied and reports a bounded resume warning', async () => {
    await settings.write({
      concurrency: {},
      unitConcurrency: 1,
      paused: [],
      pausedSteps: ['canonical'],
      services: {},
    });
    released.result = {
      documents: 1,
      byStep: { canonical: 1, preview: 1, markdown: 1, analysis: 0, fields: 0, vectorization: 0 },
      hasMore: true,
      warnings: [],
    };

    const result = await control.update(
      { kind: 'step', step: 'canonical', expectedRevision: 1, paused: false },
      'admin',
    );

    expect(result.apply.status).toBe('APPLIED_WITH_WARNINGS');
    expect(result.resumed).toEqual([
      { step: 'canonical', documents: 1, hasMore: true },
      { step: 'preview', documents: 1, hasMore: true },
      { step: 'markdown', documents: 1, hasMore: true },
    ]);
    expect((await settings.read()).pausedSteps).toEqual([]);
  });
});
