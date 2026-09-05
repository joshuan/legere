import { beforeEach, describe, expect, it } from 'vitest';
import {
  documentFixture,
  FakeDocumentEventRepository,
  InMemoryDocumentRepository,
  InMemorySettingsRepository,
  queueSettingsFixture,
} from '../../../../test/helpers/processing-fakes';
import type { DocumentStep } from '../../../shared/contracts/documents';
import { ReprocessDocument } from '../documents/reprocess-document';
import { JobQueue, type EnqueueOptions, type QueueName } from '../ports/job-queue';
import type { TransactionHandle } from '../ports/unit-of-work';
import { QUEUE_SETTINGS_KEY } from './queue-settings';
import { ResumeReleasedPipelineWork } from './resume-released-pipeline-work';

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

describe('ResumeReleasedPipelineWork', () => {
  let documents: InMemoryDocumentRepository;
  let events: FakeDocumentEventRepository;
  let queue: RecordingJobQueue;
  let settingsStore: InMemorySettingsRepository;

  beforeEach(() => {
    documents = new InMemoryDocumentRepository();
    events = new FakeDocumentEventRepository();
    queue = new RecordingJobQueue();
    settingsStore = new InMemorySettingsRepository();
  });

  function useCase(maxDocuments = 500): ResumeReleasedPipelineWork {
    const settings = queueSettingsFixture(4, settingsStore);
    return new ResumeReleasedPipelineWork(
      documents,
      new ReprocessDocument(documents, events, queue, settings),
      maxDocuments,
    );
  }

  function paused(...steps: DocumentStep[]): ReadonlySet<DocumentStep> {
    return new Set(steps);
  }

  it('releases an unsettled canonical and every dependent pending step in one document job', async () => {
    documents.add(documentFixture());

    const result = await useCase().execute({
      before: paused('canonical'),
      after: paused(),
      actorId: 'admin-id',
    });

    expect(queue.enqueued).toEqual([
      {
        name: 'document-process',
        payload: {
          documentId: '11111111-1111-4111-8111-111111111111',
          steps: ['canonical', 'preview', 'markdown', 'analysis', 'fields', 'vectorization'],
        },
      },
    ]);
    expect(result).toEqual({
      documents: 1,
      byStep: {
        canonical: 1,
        preview: 1,
        markdown: 1,
        analysis: 1,
        fields: 1,
        vectorization: 1,
      },
      hasMore: false,
      warnings: [],
    });
    expect(events.events[0]).toMatchObject({
      type: 'QUEUED',
      actorId: 'admin-id',
      payload: {
        steps: ['canonical', 'preview', 'markdown', 'analysis', 'fields', 'vectorization'],
      },
    });
  });

  it('keeps the markdown cascade held when only canonical is released', async () => {
    documents.add(documentFixture());
    await settingsStore.write(QUEUE_SETTINGS_KEY, { pausedSteps: ['markdown'] });

    const result = await useCase().execute({
      before: paused('canonical', 'markdown'),
      after: paused('markdown'),
    });

    expect(queue.enqueued[0]?.payload).toEqual({
      documentId: '11111111-1111-4111-8111-111111111111',
      steps: ['canonical', 'preview'],
    });
    expect(result.byStep).toEqual({
      canonical: 1,
      preview: 1,
      markdown: 0,
      analysis: 0,
      fields: 0,
      vectorization: 0,
    });
  });

  it('releases markdown and its readers together without rerunning unrelated preview work', async () => {
    documents.add(
      documentFixture({
        steps: {
          canonical: 'DONE',
          preview: 'PENDING',
          markdown: 'PENDING',
          analysis: 'PENDING',
          fields: 'PENDING',
          vectorization: 'PENDING',
        },
      }),
    );

    const result = await useCase().execute({
      before: paused('markdown'),
      after: paused(),
    });

    expect(queue.enqueued[0]?.payload).toEqual({
      documentId: '11111111-1111-4111-8111-111111111111',
      steps: ['markdown', 'analysis', 'fields', 'vectorization'],
    });
    expect(result.byStep).toEqual({
      canonical: 0,
      preview: 0,
      markdown: 1,
      analysis: 1,
      fields: 1,
      vectorization: 1,
    });
  });

  it('releases fields with analysis only while the document still has no type', async () => {
    documents.add(documentFixture({ id: '11111111-1111-4111-8111-111111111111' }));
    documents.add(
      documentFixture({
        id: '22222222-2222-4222-8222-222222222222',
        typeId: 'type-id',
      }),
    );

    const result = await useCase().execute({
      before: paused('analysis'),
      after: paused(),
    });

    expect(queue.enqueued.map((job) => job.payload)).toEqual([
      {
        documentId: '11111111-1111-4111-8111-111111111111',
        steps: ['analysis', 'fields'],
      },
      {
        documentId: '22222222-2222-4222-8222-222222222222',
        steps: ['analysis'],
      },
    ]);
    expect(result.byStep.analysis).toBe(2);
    expect(result.byStep.fields).toBe(1);
  });

  it('bounds one resume, reports a remainder, and includes queued work left by an old job', async () => {
    documents.add(
      documentFixture({
        id: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    );
    documents.add(
      documentFixture({
        id: '22222222-2222-4222-8222-222222222222',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    );
    documents.add(
      documentFixture({
        id: '33333333-3333-4333-8333-333333333333',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        steps: {
          canonical: 'QUEUED',
          preview: 'PENDING',
          markdown: 'PENDING',
          analysis: 'PENDING',
          fields: 'PENDING',
          vectorization: 'PENDING',
        },
      }),
    );

    const result = await useCase(2).execute({
      before: paused('canonical'),
      after: paused(),
    });

    expect(result.documents).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(queue.enqueued.map((job) => job.payload)).toEqual([
      {
        documentId: '22222222-2222-4222-8222-222222222222',
        steps: ['canonical', 'preview', 'markdown', 'analysis', 'fields', 'vectorization'],
      },
      {
        documentId: '33333333-3333-4333-8333-333333333333',
        steps: ['canonical', 'preview', 'markdown', 'analysis', 'fields', 'vectorization'],
      },
    ]);
  });

  it('warns and preserves a newer pause that wins while the resume is starting', async () => {
    documents.add(documentFixture());
    // Input describes the release already accepted by the caller, but the settings read inside the
    // ordinary reprocess sees a newer command that paused the step again.
    await settingsStore.write(QUEUE_SETTINGS_KEY, { pausedSteps: ['canonical'] });

    const result = await useCase().execute({
      before: paused('canonical'),
      after: paused(),
    });

    expect(queue.enqueued).toEqual([]);
    expect(result).toMatchObject({
      documents: 0,
      hasMore: true,
      warnings: ['1 document(s) remained held because pipeline pauses changed again'],
    });
  });

  it('does nothing when no configured pause was released', async () => {
    documents.add(documentFixture());

    const result = await useCase().execute({
      before: paused('canonical'),
      after: paused('canonical', 'preview'),
    });

    expect(result.documents).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(queue.enqueued).toEqual([]);
  });
});
