import { type QueueName } from '../../application/ports/job-queue';
import { PROCESSING_TOPOLOGY } from '../../application/processing/processing-topology';

// Retry policy shared by every queue (docs/06 §6.8).
export const RETRY_LIMIT = 5;

// How long a job may stay `active` before pg-boss decides its worker is gone and hands it to
// someone else. This is recovery time after a crash/deploy, not a timeout for the work itself.
export const EXPIRE_IN_SECONDS: Readonly<Record<QueueName, number>> = {
  'library-scan': queueDefinition('library-scan').expireInSeconds,
  'file-ingest': queueDefinition('file-ingest').expireInSeconds,
  'document-process': queueDefinition('document-process').expireInSeconds,
  maintenance: queueDefinition('maintenance').expireInSeconds,
};

export function policyOf(name: QueueName): 'stately' | 'short' | 'standard' {
  return queueDefinition(name).policy;
}

function queueDefinition(name: QueueName) {
  const definition = PROCESSING_TOPOLOGY.queues.find((queue) => queue.name === name);
  if (definition === undefined) throw new Error(`Processing topology omits queue ${name}`);
  return definition;
}
