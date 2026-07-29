import type { QueueName } from './job-queue';

// Admin queue observability (docs/05 §5.8, docs/07 admin queue).
export type QueueDepth = {
  name: QueueName;
  queued: number;
  active: number;
  failedRecent: number;
};

export type FailedJob = {
  jobId: string;
  queue: string;
  payload: unknown;
  error: string;
  failedAt: string;
  retryCount: number;
};

export type FailedJobPage = {
  items: FailedJob[];
  nextCursor: string | null;
};

export abstract class QueueMonitor {
  abstract depths(): Promise<QueueDepth[]>;

  abstract failedJobs(cursor?: string, limit?: number): Promise<FailedJobPage>;

  // Re-enqueues a copy of a failed job (docs/07 admin queue).
  abstract retry(jobId: string): Promise<boolean>;

  // Feeds the health endpoint (docs/06 §6.10).
  abstract isHealthy(): Promise<boolean>;
}
