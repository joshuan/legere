import type { QueueName } from './job-queue';

// Admin queue observability (docs/05 §5.8, docs/07 admin queue).
export type QueueDepth = {
  name: QueueName;
  queued: number;
  active: number;
  failedRecent: number;
  oldestQueuedAt: string | null;
  lastCompletedAt: string | null;
  completedLastHour: number;
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

// The immutable work recorded by one failed journal row. QueueMonitor only reads it; deciding
// whether and how it may be enqueued again belongs to the application use case.
export type FailedJobWork = {
  queue: string;
  payload: unknown;
};

export abstract class QueueMonitor {
  abstract depths(): Promise<QueueDepth[]>;

  abstract failedJobs(cursor?: string, limit?: number): Promise<FailedJobPage>;

  abstract failedJob(jobId: string): Promise<FailedJobWork | null>;

  // Feeds the health endpoint (docs/06 §6.10).
  abstract isHealthy(): Promise<boolean>;
}
