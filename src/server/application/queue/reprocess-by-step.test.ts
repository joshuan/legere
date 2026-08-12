import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentFixture,
  FakeDocumentEventRepository,
  InMemoryDocumentRepository,
} from '../../../../test/helpers/processing-fakes';
import { ReprocessDocument } from '../documents/reprocess-document';
import { JobQueue, type EnqueueOptions, type QueueName } from '../ports/job-queue';
import type { TransactionHandle } from '../ports/unit-of-work';
import { ReprocessDocumentsByStep } from './reprocess-by-step';

// Records what was enqueued; nothing else here needs a queue.
class RecordingJobQueue extends JobQueue {
  readonly enqueued: Array<{ name: QueueName; payload: object; options?: EnqueueOptions }> = [];

  enqueue(name: QueueName, payload: object, options?: EnqueueOptions): Promise<string | null> {
    this.enqueued.push({ name, payload, ...(options === undefined ? {} : { options }) });
    return Promise.resolve('job-id');
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

// "The previews failed, run them again" (docs/07 §7.3, docs/11 §11.13).
describe('ReprocessDocumentsByStep', () => {
  let documents: InMemoryDocumentRepository;
  let events: FakeDocumentEventRepository;
  let queue: RecordingJobQueue;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    events = new FakeDocumentEventRepository();
    queue = new RecordingJobQueue();
  });

  function useCase(maxPerCall = 500): ReprocessDocumentsByStep {
    return new ReprocessDocumentsByStep(
      documents,
      new ReprocessDocument(documents, events, queue),
      maxPerCall,
    );
  }

  // A document whose steps are all DONE except the one named, which sits where the test wants it.
  function given(id: string, failed: 'preview' | 'markdown', createdAt: string): void {
    documents.documents.set(
      id,
      documentFixture({
        id,
        createdAt: new Date(createdAt),
        steps: {
          canonical: 'DONE',
          preview: failed === 'preview' ? 'FAILED' : 'DONE',
          markdown: failed === 'markdown' ? 'FAILED' : 'DONE',
          analysis: 'DONE',
          vectorization: 'DONE',
        },
      }),
    );
  }

  it('re-enqueues exactly the documents whose step sits in that status', async () => {
    given('11111111-1111-4111-8111-111111111111', 'preview', '2026-01-01T00:00:00.000Z');
    given('22222222-2222-4222-8222-222222222222', 'preview', '2026-02-01T00:00:00.000Z');
    given('33333333-3333-4333-8333-333333333333', 'markdown', '2026-03-01T00:00:00.000Z');

    const result = await useCase().execute({ step: 'preview', status: 'FAILED' }, 'admin-id');

    expect(result).toEqual({ enqueued: 2 });
    expect(queue.enqueued).toHaveLength(2);
    expect(queue.enqueued.map((job) => job.name)).toEqual(['document-process', 'document-process']);
    // Only the step asked for, and keyed by the document so it is one piece of work in the queue.
    expect(queue.enqueued[0]).toMatchObject({
      payload: { documentId: '22222222-2222-4222-8222-222222222222', steps: ['preview'] },
      options: { singletonKey: '22222222-2222-4222-8222-222222222222' },
    });
  });

  it('puts the step back in the queue and records who asked, like a single reprocess', async () => {
    given('11111111-1111-4111-8111-111111111111', 'preview', '2026-01-01T00:00:00.000Z');

    await useCase().execute({ step: 'preview', status: 'FAILED' }, 'admin-id');

    const document = documents.documents.get('11111111-1111-4111-8111-111111111111');
    expect(document?.steps.preview).toBe('QUEUED');
    // 🔒 The steps nobody asked for keep the state they had (docs/07 §7.3).
    expect(document?.steps.markdown).toBe('DONE');
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({
      type: 'QUEUED',
      actorId: 'admin-id',
      payload: { steps: ['preview'] },
    });
  });

  it('takes at most the cap a call is allowed, newest first', async () => {
    given('11111111-1111-4111-8111-111111111111', 'preview', '2026-01-01T00:00:00.000Z');
    given('22222222-2222-4222-8222-222222222222', 'preview', '2026-02-01T00:00:00.000Z');
    given('33333333-3333-4333-8333-333333333333', 'preview', '2026-03-01T00:00:00.000Z');

    const result = await useCase(2).execute({ step: 'preview', status: 'FAILED' });

    // Bounded, so a large archive drains in batches rather than one push (docs/12 §12.4).
    expect(result).toEqual({ enqueued: 2 });
    expect(queue.enqueued.map((job) => job.payload)).toEqual([
      { documentId: '33333333-3333-4333-8333-333333333333', steps: ['preview'] },
      { documentId: '22222222-2222-4222-8222-222222222222', steps: ['preview'] },
    ]);
  });

  it('enqueues nothing when no document is in that state', async () => {
    given('11111111-1111-4111-8111-111111111111', 'preview', '2026-01-01T00:00:00.000Z');

    const result = await useCase().execute({ step: 'analysis', status: 'FAILED' });

    expect(result).toEqual({ enqueued: 0 });
    expect(queue.enqueued).toHaveLength(0);
  });
});
