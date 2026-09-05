import { describe, expect, it } from 'vitest';
import { PROCESSING_QUEUE_NAMES } from '../../../shared/contracts/processing';
import { PROCESSING_WORKER_BINDINGS } from './jobs.module';

describe('JobsModule processing worker bindings', () => {
  it('registers every queue in the control-plane topology exactly once', () => {
    const queues = PROCESSING_WORKER_BINDINGS.map(({ queue }) => queue);
    expect(queues).toEqual(PROCESSING_QUEUE_NAMES);
    expect(new Set(queues).size).toBe(PROCESSING_QUEUE_NAMES.length);
  });
});
