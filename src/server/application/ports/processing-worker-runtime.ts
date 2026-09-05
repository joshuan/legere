import type { QueueSettingsDto } from '../../../shared/contracts/queue';
import type { QueueName } from './job-queue';

export type ProcessingWorkerState = {
  queue: QueueName;
  registered: boolean;
  appliedConcurrency: number | null;
};

// The application asks for desired worker state through this port; how pg-boss stops and registers
// workers remains infrastructure's concern.
export abstract class ProcessingWorkerRuntime {
  abstract reconfigure(
    queues: readonly QueueName[],
    settings: Pick<QueueSettingsDto, 'concurrency' | 'paused'>,
  ): Promise<void>;

  abstract snapshot(): ProcessingWorkerState[];
}
