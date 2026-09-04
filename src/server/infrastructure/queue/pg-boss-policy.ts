import { type QueueName } from '../../application/ports/job-queue';

// Retry policy shared by every queue (docs/06 §6.8).
export const RETRY_LIMIT = 5;

// How long a job may stay `active` before pg-boss decides its worker is gone and hands it to
// someone else. This is recovery time after a crash/deploy, not a timeout for the work itself.
export const EXPIRE_IN_SECONDS: Readonly<Record<QueueName, number>> = {
  'library-scan': 15 * 60,
  'file-ingest': 10 * 60,
  // 🔒 This exceeds the 165-minute sum of the per-step budgets in docs/05 §5.4a. A premature
  // reclaim does not cancel the old handler; it starts a duplicate while the first still runs.
  'document-process': 3 * 60 * 60,
  maintenance: 15 * 60,
};

// Queues whose work is keyed by an entity get pg-boss's `stately` policy: at most one queued and
// one active job per singleton key (docs/05 §5.2, §5.4; docs/06 §6.8).
const SINGLETON_QUEUES: ReadonlySet<QueueName> = new Set(['library-scan']);

// A `short` queue collapses matching work waiting in `created`, but permits a new job while the
// previous one runs. A composition edit during processing therefore still gets rebuilt.
const DEBOUNCED_QUEUES: ReadonlySet<QueueName> = new Set(['document-process']);

export function policyOf(name: QueueName): 'stately' | 'short' | 'standard' {
  if (SINGLETON_QUEUES.has(name)) return 'stately';
  if (DEBOUNCED_QUEUES.has(name)) return 'short';
  return 'standard';
}
