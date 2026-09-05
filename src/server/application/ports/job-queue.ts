import {
  PROCESSING_QUEUE_NAMES,
  type ProcessingQueueName,
} from '../../../shared/contracts/processing';
import type { TransactionHandle } from './unit-of-work';

// Queue names (docs/05 §5.4). Kept as a const list so the worker registry and the admin overview
// cannot drift from the handlers.
export const QUEUE_NAMES = PROCESSING_QUEUE_NAMES;
export type QueueName = ProcessingQueueName;

export type EnqueueOptions = {
  // pg-boss singleton key: at most one queued job per key, used for one scan per library
  // (docs/06 §6.8).
  singletonKey?: string;
  // Higher runs first; user-triggered work outranks background work (docs/05 §5.4).
  priority?: number;
};

// What one piece of queued `document-process` work is. pg-boss's `short` policy may collapse two
// requests for the same set of steps while both are waiting, while a composition rebuild and a
// one-step repair must both survive.
//
// Kept at the queue boundary rather than in the pg-boss adapter so another adapter cannot silently
// choose a different identity. Payloads reaching the handler have already been validated, while
// enqueueing remains deliberately generic and therefore earns the defensive checks below.
export function documentProcessWorkKey(payload: object): string | undefined {
  const asked: Record<string, unknown> = { ...payload };
  const documentId = asked.documentId;
  if (typeof documentId !== 'string') return undefined;

  const raw: unknown[] = Array.isArray(asked.steps) ? asked.steps : [];
  const steps = [...new Set(raw.filter((step): step is string => typeof step === 'string'))].sort();
  // An absent/empty list means the complete pipeline. `#full` distinguishes a deliberate request
  // to analyse a long document from the ordinary run that may stop at its automatic page limit.
  const full = asked.analyseInFull === true ? '#full' : '';
  return steps.length === 0 ? `${documentId}${full}` : `${documentId}${full}#${steps.join('+')}`;
}

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
