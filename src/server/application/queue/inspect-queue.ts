import { DOCUMENT_STEPS } from '../../../shared/contracts/documents';
import type {
  ListQueueFailuresResponse,
  QueueOverviewResponse,
} from '../../../shared/contracts/queue';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import type { MetricsCache } from '../ports/metrics-cache';
import { QUEUE_NAMES, type JobQueue, type QueueName } from '../ports/job-queue';
import type { QueueMonitor } from '../ports/queue-monitor';
import type { ServiceGates } from './service-gate';

// GET /api/admin/queue/overview (docs/07 §7.3, docs/05 §5.8): what the queue is doing right now,
// and where the documents themselves stand in the pipeline.
export class GetQueueOverview {
  constructor(
    private readonly monitor: QueueMonitor,
    private readonly documents: DocumentRepository,
    // The vectors themselves: one grouped count, so the panel that owns the pipeline can say
    // whether the archive holds one geometry or two (docs/04 §4.5).
    private readonly chunks: DocumentChunkRepository,
    private readonly metrics: MetricsCache,
    // What each gate of docs/05 §5.4b is doing this instant. In-process and free to read, which is
    // why it rides with the counters rather than behind a route of its own.
    private readonly gates: ServiceGates,
  ) {}

  async execute(): Promise<QueueOverviewResponse> {
    const [queues, counters, byModel] = await Promise.all([
      this.monitor.depths(),
      this.documents.countByStepStatus(),
      this.chunks.countByModel(),
    ]);

    return {
      queues,
      documents: {
        total: counters.total,
        // Always all six steps, in pipeline order, even when a status has no documents in it —
        // a card that disappears when it reaches zero is worse than one showing zero.
        steps: DOCUMENT_STEPS.map((step) => ({ step, counts: counters.steps[step] })),
      },
      // What the vectorization step has actually produced, and by which model (docs/03 §3.3.11).
      vectors: {
        chunks: byModel.reduce((total, row) => total + row.chunks, 0),
        byModel,
      },
      // 🔒 The only honest witness to a gate that is working: a step waiting at one reads as RUNNING
      // exactly like a step doing the work (docs/05 §5.4b).
      gates: this.gates.snapshot(),
      // Null until maintenance has run once: an honest "not measured yet" beats a zero that looks
      // like an empty bucket (docs/09 §9.5).
      storage: this.metrics.getStorageUsage(),
    };
  }
}

export class ListQueueFailures {
  constructor(private readonly monitor: QueueMonitor) {}

  execute(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<ListQueueFailuresResponse> {
    return this.monitor.failedJobs(query.cursor, query.limit);
  }
}

export class RetryFailedJob {
  constructor(
    private readonly monitor: QueueMonitor,
    private readonly queue: JobQueue,
  ) {}

  async execute(jobId: string): Promise<{ ok: true }> {
    // A job that already left the failed state (retried by someone else, or archived) is simply
    // not there any more — the same answer as a made-up id.
    const failed = await this.monitor.failedJob(jobId);
    if (failed === null || !isQueueName(failed.queue)) {
      throw new NotFoundError('NOT_FOUND', 'Failed job not found');
    }
    await this.queue.enqueue(failed.queue, payloadOf(failed.payload));
    return { ok: true };
  }
}

function isQueueName(value: string): value is QueueName {
  return QUEUE_NAMES.some((queue) => queue === value);
}

function payloadOf(value: unknown): object {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
