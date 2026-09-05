import { beforeEach, describe, expect, it } from 'vitest';
import { JobQueue, type EnqueueOptions, type QueueName } from '../ports/job-queue';
import {
  QueueMonitor,
  type FailedJobPage,
  type FailedJobWork,
  type QueueDepth,
} from '../ports/queue-monitor';
import type { TransactionHandle } from '../ports/unit-of-work';
import { RetryFailedJob } from './inspect-queue';

class StubQueueMonitor extends QueueMonitor {
  work: FailedJobWork | null = null;

  depths(): Promise<QueueDepth[]> {
    return Promise.resolve([]);
  }

  failedJobs(): Promise<FailedJobPage> {
    return Promise.resolve({ items: [], nextCursor: null });
  }

  failedJob(): Promise<FailedJobWork | null> {
    return Promise.resolve(this.work);
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class RecordingJobQueue extends JobQueue {
  readonly enqueued: Array<{ name: QueueName; payload: object; options?: EnqueueOptions }> = [];

  enqueue(name: QueueName, payload: object, options?: EnqueueOptions): Promise<string | null> {
    this.enqueued.push({ name, payload, ...(options === undefined ? {} : { options }) });
    // A matching `short` job already waiting is still a successful retry request.
    return Promise.resolve(null);
  }

  enqueueAfterTx(
    _tx: TransactionHandle,
    name: QueueName,
    payload: object,
    options?: EnqueueOptions,
  ): Promise<string | null> {
    return this.enqueue(name, payload, options);
  }

  scheduleCron(): Promise<void> {
    return Promise.resolve();
  }

  unscheduleCron(): Promise<void> {
    return Promise.resolve();
  }
}

describe('RetryFailedJob', () => {
  let monitor: StubQueueMonitor;
  let queue: RecordingJobQueue;
  let retry: RetryFailedJob;

  beforeEach(() => {
    monitor = new StubQueueMonitor();
    queue = new RecordingJobQueue();
    retry = new RetryFailedJob(monitor, queue);
  });

  it('copies known failed work through the policy-aware JobQueue', async () => {
    monitor.work = {
      queue: 'document-process',
      payload: { documentId: '11111111-1111-4111-8111-111111111111' },
    };

    await expect(retry.execute('failed-id')).resolves.toEqual({ ok: true });

    expect(queue.enqueued).toEqual([
      {
        name: 'document-process',
        payload: { documentId: '11111111-1111-4111-8111-111111111111' },
      },
    ]);
  });

  it('preserves NotFound for a missing or no-longer-failed journal row', async () => {
    await expect(retry.execute('missing-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    expect(queue.enqueued).toEqual([]);
  });

  it('refuses a journal row for a queue this application does not own', async () => {
    monitor.work = { queue: '__pgboss__maintenance', payload: { destructive: true } };

    await expect(retry.execute('foreign-id')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      httpStatus: 404,
    });
    expect(queue.enqueued).toEqual([]);
  });
});
