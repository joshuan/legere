import type { TransactionHandle } from './unit-of-work';

// Queue names (docs/05 §5.4). Kept as a const list so the worker registry and the admin overview
// cannot drift from the handlers.
export const QUEUE_NAMES = [
  'library-scan',
  'file-ingest',
  'document-process',
  'maintenance',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export type EnqueueOptions = {
  // pg-boss singleton key: at most one queued job per key, used for one scan per library
  // (docs/06 §6.8).
  singletonKey?: string;
  // Higher runs first; user-triggered work outranks background work (docs/05 §5.4).
  priority?: number;
};

// Job enqueueing (docs/06 §6.3.3). Payloads are plain JSON — never entities.
export abstract class JobQueue {
  abstract enqueue(
    name: QueueName,
    payload: object,
    options?: EnqueueOptions,
  ): Promise<string | null>;

  // Enqueues on the transaction's own connection, so the job insert commits — or rolls back —
  // together with the entity write that caused it (docs/06 §6.3.4).
  abstract enqueueAfterTx(
    tx: TransactionHandle,
    name: QueueName,
    payload: object,
    options?: EnqueueOptions,
  ): Promise<string | null>;

  // Registers (or re-registers) a cron schedule; re-registration replaces the previous spec so a
  // changed scan interval takes effect without leaving a stale schedule behind (docs/06 §6.8).
  abstract scheduleCron(
    name: QueueName,
    cron: string,
    payload?: object,
    key?: string,
  ): Promise<void>;

  abstract unscheduleCron(name: QueueName, key?: string): Promise<void>;
}
