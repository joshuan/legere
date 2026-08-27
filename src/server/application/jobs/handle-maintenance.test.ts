import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryEmailVerificationRepository,
  InMemoryPasswordResetRepository,
  InMemoryUserInviteRepository,
} from '../../../../test/helpers/fakes';
import {
  documentFixture,
  ImmediateUnitOfWork,
  LIBRARY_ID,
  InMemoryDocumentRepository,
  InMemoryFileRefRepository,
  InMemoryFileRepository,
  InMemorySettingsRepository,
  queueSettingsFixture,
} from '../../../../test/helpers/processing-fakes';
import { JobQueue, type EnqueueOptions, type QueueName } from '../../application/ports/job-queue';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { InMemoryMetricsCache } from '../../infrastructure/storage/in-memory-metrics-cache';
import { DOCUMENT_STEPS } from '../../../shared/contracts/documents';
import { QUEUE_SETTINGS_KEY } from '../queue/queue-settings';
import { HandleMaintenance } from './handle-maintenance';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// The default of docs/12 §12.4, so the test asks the question the product actually answers.
const RETENTION_DAYS = 30;

const LIVE_DOCUMENT = '11111111-1111-4111-8111-111111111111';
const DELETED_DOCUMENT = '22222222-2222-4222-8222-222222222222';
const GONE_DOCUMENT = '33333333-3333-4333-8333-333333333333';
const LIVE_FILE = '44444444-4444-4444-8444-444444444444';
const GONE_FILE = '55555555-5555-4555-8555-555555555555';

// The hourly housekeeping job (docs/06 §6.8, docs/09 §9.5).
// Records what the sweep enqueued; nothing else here needs a queue.
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

describe('HandleMaintenance', () => {
  let clock: FixedClock;
  let verifications: InMemoryEmailVerificationRepository;
  let invites: InMemoryUserInviteRepository;
  let resets: InMemoryPasswordResetRepository;
  let documents: InMemoryDocumentRepository;
  let fileRows: InMemoryFileRepository;
  let fileRefs: InMemoryFileRefRepository;
  let files: InMemoryFileStorage;
  let metrics: InMemoryMetricsCache;
  let queue: RecordingJobQueue;
  let handler: HandleMaintenance;
  // Where a paused step lives, so a test can hold one and watch the sweep leave it alone
  // (docs/05 §5.4d).
  let queueStore: InMemorySettingsRepository;

  beforeEach(() => {
    queueStore = new InMemorySettingsRepository();
    clock = new FixedClock(NOW);
    verifications = new InMemoryEmailVerificationRepository(clock);
    invites = new InMemoryUserInviteRepository();
    resets = new InMemoryPasswordResetRepository();
    documents = new InMemoryDocumentRepository();
    fileRows = new InMemoryFileRepository();
    files = new InMemoryFileStorage();
    metrics = new InMemoryMetricsCache();
    queue = new RecordingJobQueue();
    fileRefs = new InMemoryFileRefRepository();
    handler = new HandleMaintenance(
      verifications,
      invites,
      resets,
      documents,
      fileRows,
      fileRefs,
      files,
      metrics,
      queue,
      queueSettingsFixture(4, queueStore),
      new ImmediateUnitOfWork(),
      clock,
      RETENTION_DAYS,
    );
  });

  async function givenCredentials(): Promise<void> {
    for (const [email, expiresAt] of [
      ['stale@legere.local', new Date(NOW.getTime() - HOUR)],
      ['fresh@legere.local', new Date(NOW.getTime() + HOUR)],
    ] as const) {
      await verifications.replace({
        email,
        purpose: 'REGISTRATION',
        codeHash: 'code',
        expiresAt,
        inviteId: null,
        passwordResetId: null,
      });
    }

    invites.invites.push(
      {
        id: 'invite-stale',
        tokenHash: 'stale',
        role: 'USER',
        emailHint: null,
        createdById: 'admin',
        expiresAt: new Date(NOW.getTime() - HOUR),
        revokedAt: null,
        acceptedAt: null,
        acceptedById: null,
        createdAt: NOW,
      },
      {
        id: 'invite-fresh',
        tokenHash: 'fresh',
        role: 'USER',
        emailHint: null,
        createdById: 'admin',
        expiresAt: new Date(NOW.getTime() + HOUR),
        revokedAt: null,
        acceptedAt: null,
        acceptedById: null,
        createdAt: NOW,
      },
    );

    await resets.create({
      tokenHash: 'stale',
      userId: 'user-1',
      createdById: 'admin',
      expiresAt: new Date(NOW.getTime() - HOUR),
    });
    await resets.create({
      tokenHash: 'fresh',
      userId: 'user-1',
      createdById: 'admin',
      expiresAt: new Date(NOW.getTime() + HOUR),
    });
  }

  it('deletes one-time credentials that have expired and keeps the live ones', async () => {
    await givenCredentials();

    await handler.handle();

    expect([...verifications.records.values()].map((record) => record.email)).toEqual([
      'fresh@legere.local',
    ]);
    expect(invites.invites.map((invite) => invite.id)).toEqual(['invite-fresh']);
    expect(resets.resets.map((reset) => reset.tokenHash)).toEqual(['fresh']);
  });

  it('removes artifacts whose document is gone and keeps everything else', async () => {
    documents.add(documentFixture({ id: LIVE_DOCUMENT }));
    // Soft delete is reversible, so its artifacts stay (docs/09 §9.2).
    documents.add(documentFixture({ id: DELETED_DOCUMENT, deletedAt: NOW }));

    await files.put(`documents/${LIVE_DOCUMENT}/preview.jpg`, Buffer.alloc(10), 'image/jpeg');
    await files.put(`documents/${DELETED_DOCUMENT}/thumb.jpg`, Buffer.alloc(20), 'image/jpeg');
    await files.put(
      `documents/${GONE_DOCUMENT}/canonical.pdf`,
      Buffer.alloc(40),
      'application/pdf',
    );
    await files.put(`documents/${GONE_DOCUMENT}/preview.jpg`, Buffer.alloc(80), 'image/jpeg');
    // Not part of the documents/{id}/ layout: left alone rather than guessed about.
    await files.put('exports/report.csv', Buffer.alloc(5), 'text/csv');

    await handler.handle();

    expect(files.keys()).toEqual([
      `documents/${LIVE_DOCUMENT}/preview.jpg`,
      `documents/${DELETED_DOCUMENT}/thumb.jpg`,
      'exports/report.csv',
    ]);
  });

  // The other half of the layout, and the reason a hard delete may fail part-way without leaking:
  // the objects of a file row that no longer exists (docs/03 §3.3.10, docs/09 §9.2).
  it('removes a managed original whose file row is gone and keeps the ones still held', async () => {
    fileRows.add({ id: LIVE_FILE, origin: 'MANAGED', ext: 'jpg' });

    await files.put(`files/${LIVE_FILE}/original.jpg`, Buffer.alloc(10), 'image/jpeg');
    await files.put(`files/${GONE_FILE}/original.jpg`, Buffer.alloc(20), 'image/jpeg');

    await handler.handle();

    expect(files.keys()).toEqual([`files/${LIVE_FILE}/original.jpg`]);
  });

  // 🔒 The one destruction in Legere that happens on a clock (docs/05 §5.7a) — and the half of it
  // that must never fire is the library original, whose bytes are on a volume we may not write to.
  describe('the trash, once its time is up', () => {
    const OURS = '66666666-6666-4666-8666-666666666666';
    const THEIRS = '77777777-7777-4777-8777-777777777777';
    const RECENT = '88888888-8888-4888-8888-888888888888';

    beforeEach(async () => {
      const longAgo = new Date(NOW.getTime() - (RETENTION_DAYS + 1) * DAY);
      // Ours, and past the window: this is what the sweep is for.
      fileRows.add({ id: OURS, origin: 'MANAGED', ext: 'jpg', trashedAt: longAgo }, null);
      // Theirs, and older still — and it stays, however long it waits.
      fileRows.add({ id: THEIRS, origin: 'LIBRARY', storageKey: null, trashedAt: longAgo }, null);
      // Ours, but thrown away this morning.
      fileRows.add(
        { id: RECENT, origin: 'MANAGED', ext: 'jpg', trashedAt: new Date(NOW.getTime() - HOUR) },
        null,
      );

      await files.put(`files/${OURS}/original.jpg`, Buffer.alloc(10), 'image/jpeg');
      await files.put(`files/${RECENT}/original.jpg`, Buffer.alloc(10), 'image/jpeg');
    });

    it('deletes what is ours and past the window, and nothing else', async () => {
      await handler.handle();

      const left = (await fileRows.listAllTrashed()).map((file) => file.id).sort();
      expect(left).toEqual([RECENT, THEIRS].sort());
      expect(files.keys()).toEqual([`files/${RECENT}/original.jpg`]);
    });

    it('leaves the paths of a purged library original excluded, so no scan brings it back', async () => {
      fileRefs.add({ id: 'ref-1', libraryId: LIBRARY_ID, fileId: THEIRS });

      await handler.handle();

      // It was not purged, so its ref is untouched: the exclusion happens when somebody deletes it
      // by hand (docs/05 §5.7a), and until then the file is simply waiting.
      expect(fileRefs.refs.map((ref) => ref.status)).toEqual(['HASHED']);
    });
  });

  it('caches what the bucket holds after the sweep, stamped with the time it was measured', async () => {
    documents.add(documentFixture({ id: LIVE_DOCUMENT }));
    await files.put(`documents/${LIVE_DOCUMENT}/preview.jpg`, Buffer.alloc(1000), 'image/jpeg');
    await files.put(`documents/${GONE_DOCUMENT}/preview.jpg`, Buffer.alloc(500), 'image/jpeg');

    expect(metrics.getStorageUsage()).toBeNull();

    await handler.handle();

    // 500 orphaned bytes were deleted in this very run — counting them would misreport the bucket.
    expect(metrics.getStorageUsage()).toEqual({
      objects: 1,
      bytes: '1000',
      measuredAt: NOW.toISOString(),
    });
  });

  it('changes nothing when the same job is delivered twice', async () => {
    await givenCredentials();
    documents.add(documentFixture({ id: LIVE_DOCUMENT }));
    await files.put(`documents/${LIVE_DOCUMENT}/preview.jpg`, Buffer.alloc(10), 'image/jpeg');
    await files.put(`documents/${GONE_DOCUMENT}/preview.jpg`, Buffer.alloc(10), 'image/jpeg');

    await handler.handle();
    const afterFirst = { keys: files.keys(), usage: metrics.getStorageUsage() };
    await handler.handle();

    expect(files.keys()).toEqual(afterFirst.keys);
    expect(metrics.getStorageUsage()).toEqual(afterFirst.usage);
    expect(invites.invites.map((invite) => invite.id)).toEqual(['invite-fresh']);
  });

  it('reports an empty bucket rather than nothing at all', async () => {
    await handler.handle();

    expect(metrics.getStorageUsage()).toEqual({
      objects: 0,
      bytes: '0',
      measuredAt: NOW.toISOString(),
    });
  });
  // A migration that resets every step has no way to enqueue anything, and a crash loses jobs
  // outright. Either way the document waits at PENDING until this sweep notices (docs/05 §5.4).
  it('re-enqueues documents nobody is coming for, and leaves the fresh ones alone', async () => {
    const stale = documentFixture({ id: 'doc-stale' });
    const fresh = documentFixture({ id: 'doc-fresh' });
    const done = documentFixture({
      id: 'doc-done',
      steps: {
        canonical: 'DONE',
        preview: 'DONE',
        markdown: 'DONE',
        fields: 'DONE',
        analysis: 'DONE',
        vectorization: 'DONE',
      },
    });
    documents.add(stale);
    documents.add(fresh);
    documents.add(done);
    documents.setUpdatedAt('doc-stale', new Date(NOW.getTime() - 3 * 60 * 60 * 1000));
    documents.setUpdatedAt('doc-fresh', new Date(NOW.getTime() - 60 * 1000));
    documents.setUpdatedAt('doc-done', new Date(NOW.getTime() - 3 * 60 * 60 * 1000));

    await handler.handle();

    expect(queue.enqueued).toEqual([
      {
        name: 'document-process',
        // The steps that never started, which for a document nothing has touched is all six. No key
        // is passed: the queue derives one from the payload, so an hourly sweep that runs again
        // before the last one drained adds nothing (docs/05 §5.4).
        payload: { documentId: 'doc-stale', steps: [...DOCUMENT_STEPS] },
      },
    ]);
    // 🔒 And the row says so at once. The sweep is the moment a step stops being unscheduled, and a
    // counter that only moved when a worker got round to it would keep the old ambiguity alive under
    // a new name (docs/03 §3.3.10).
    expect((await documents.findById('doc-stale'))?.steps.canonical).toBe('QUEUED');
  });

  it('sweeps a step whose job went missing, not only one nothing was ever scheduled for', async () => {
    // A crash between the enqueue and the run leaves a row saying a worker is on the way when none
    // is: QUEUED is a claim about the queue, and the queue can lose it (docs/05 §5.4).
    const lost = documentFixture({
      id: 'doc-lost',
      steps: {
        canonical: 'QUEUED',
        preview: 'QUEUED',
        markdown: 'QUEUED',
        analysis: 'QUEUED',
        fields: 'QUEUED',
        vectorization: 'QUEUED',
      },
    });
    documents.add(lost);
    documents.setUpdatedAt('doc-lost', new Date(NOW.getTime() - 3 * 60 * 60 * 1000));

    await handler.handle();

    expect(queue.enqueued.map((job) => job.payload)).toEqual([
      { documentId: 'doc-lost', steps: [...DOCUMENT_STEPS] },
    ]);
  });

  it('walks through a document whose analysis a retired skip reason used to stand in for', async () => {
    // What the `MANUAL_TYPE` migration leaves behind (docs/05 §5.5 step 4): a fully processed
    // document with one step put back to PENDING, because the reading it never got is now a reading
    // it can have. Nothing enqueued it — this sweep is the whole of the plan.
    const retyped = documentFixture({
      id: 'doc-manual-type',
      typeSource: 'MANUAL',
      steps: {
        canonical: 'DONE',
        preview: 'DONE',
        markdown: 'DONE',
        analysis: 'PENDING',
        fields: 'DONE',
        vectorization: 'DONE',
      },
    });
    documents.add(retyped);
    documents.setUpdatedAt('doc-manual-type', new Date(NOW.getTime() - 3 * 60 * 60 * 1000));

    await handler.handle();

    // 🔒 That step and nothing else: re-running the six over a document that only needs its
    // analysis would recognise the scan again to arrive where it already was (docs/05 §5.4).
    expect(queue.enqueued.map((job) => job.payload)).toEqual([
      { documentId: 'doc-manual-type', steps: ['analysis'] },
    ]);
    expect((await documents.findById('doc-manual-type'))?.steps.analysis).toBe('QUEUED');
  });

  // A held step is unstarted on purpose (docs/05 §5.4d), so the sweep is not the thing that will
  // start it — and enqueueing it hourly would be an hourly job that does nothing.
  describe('a paused step (docs/05 §5.4d)', () => {
    beforeEach(() => {
      documents.add(
        documentFixture({
          id: 'doc-held',
          steps: {
            canonical: 'DONE',
            preview: 'DONE',
            markdown: 'DONE',
            analysis: 'PENDING',
            fields: 'PENDING',
            vectorization: 'DONE',
          },
        }),
      );
      documents.setUpdatedAt('doc-held', new Date(NOW.getTime() - 3 * HOUR));
    });

    it('passes over a document whose only unstarted steps are held', async () => {
      await queueStore.write(QUEUE_SETTINGS_KEY, { pausedSteps: ['analysis', 'fields'] });

      await handler.handle();

      expect(queue.enqueued).toEqual([]);
      // And nothing pretends a worker is coming for it.
      expect((await documents.findById('doc-held'))?.steps.analysis).toBe('PENDING');
    });

    it('sweeps the steps beside a held one, and leaves the held one where it is', async () => {
      await queueStore.write(QUEUE_SETTINGS_KEY, { pausedSteps: ['analysis'] });

      await handler.handle();

      expect(queue.enqueued.map((job) => job.payload)).toEqual([
        { documentId: 'doc-held', steps: ['fields'] },
      ]);
      const swept = await documents.findById('doc-held');
      expect(swept?.steps.fields).toBe('QUEUED');
      expect(swept?.steps.analysis).toBe('PENDING');
    });
  });
});
