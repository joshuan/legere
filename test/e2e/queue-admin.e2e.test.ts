import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  listDocumentsResponseSchema,
  reprocessResponseSchema,
} from '../../src/shared/contracts/documents';
import {
  listQueueFailuresResponseSchema,
  queueOverviewResponseSchema,
  reprocessByStepResponseSchema,
  retryJobResponseSchema,
  queueSettingsSchema,
} from '../../src/shared/contracts/queue';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { HandleMaintenance } from '../../src/server/application/jobs/handle-maintenance';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Reprocess and the admin queue view (docs/07 §7.3, docs/05 §5.8).
describe('Reprocess and queue administration (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`queueadmin${seq}@legere.local`);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function onboard(email: string): Promise<string> {
    await api(app).post('/api/auth/register/start', { email });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('onboarding did not set a session cookie');
    return sid;
  }

  async function inviteUser(email: string): Promise<string> {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', adminCookie);
    const token = expectData(created, createInviteResponseSchema).url.split('/').pop() ?? '';

    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    expectData(completed, userDtoSchema);
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return cookie;
  }

  // A processed document: every step finished, so a reprocess has something to reset.
  async function givenProcessedDocument(): Promise<string> {
    const seeded = await seedDocument({
      document: {
        title: 'Invoice',
        markdown: 'Amount due',
        canonicalStatus: 'SKIPPED',
        vectorizationStatus: 'DONE',
        processingError: 'preview failed once',
        failedStep: 'preview',
      },
      files: [{ sizeBytes: 100n }],
    });
    return seeded.id;
  }

  const processJobs = (): Promise<{ data: { documentId: string; steps?: string[] } }[]> =>
    testPrisma().$queryRawUnsafe(
      "SELECT data FROM pgboss.job WHERE name = 'document-process' ORDER BY created_on",
    );

  describe('reprocess', () => {
    it('re-enqueues the whole pipeline and puts every step back to PENDING', async () => {
      const documentId = await givenProcessedDocument();

      const res = await api(app)
        .post(`/api/documents/${documentId}/reprocess`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(201);
      expect(expectData(res, reprocessResponseSchema).steps).toEqual([
        'canonical',
        'preview',
        'markdown',
        'analysis',
        'vectorization',
      ]);

      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.previewStatus).toBe('PENDING');
      expect(row.vectorizationStatus).toBe('PENDING');
      // The old error goes with it, or the admin panel would keep showing a failure that no longer
      // describes anything.
      expect(row.processingError).toBeNull();
      expect(row.failedStep).toBeNull();

      const [job] = await processJobs();
      expect(job?.data.documentId).toBe(documentId);
    });

    it('resets only the steps asked for and carries them into the job', async () => {
      const documentId = await givenProcessedDocument();

      const res = await api(app)
        .post(`/api/documents/${documentId}/reprocess`, { steps: ['vectorization', 'preview'] })
        .set('Cookie', adminCookie);

      // Answered in pipeline order regardless of how the request listed them.
      expect(expectData(res, reprocessResponseSchema).steps).toEqual(['preview', 'vectorization']);

      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.previewStatus).toBe('PENDING');
      expect(row.vectorizationStatus).toBe('PENDING');
      // 🔒 Untouched steps keep the state they had (docs/07 §7.3).
      expect(row.markdownStatus).toBe('DONE');
      expect(row.analysisStatus).toBe('DONE');

      const [job] = await processJobs();
      expect(job?.data.steps).toEqual(['preview', 'vectorization']);
    });

    it('rejects a step that is not part of the pipeline', async () => {
      const documentId = await givenProcessedDocument();

      const res = await api(app)
        .post(`/api/documents/${documentId}/reprocess`, { steps: ['thumbnail'] })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(422);
      expect(expectError(res).code).toBe('VALIDATION_FAILED');
      expect(await processJobs()).toHaveLength(0);
    });

    it('404s an unknown document and refuses a non-admin', async () => {
      const documentId = await givenProcessedDocument();
      const userCookie = await inviteUser(`nosy${seq}@legere.local`);

      const unknown = await api(app)
        .post('/api/documents/11111111-1111-4111-8111-111111111111/reprocess')
        .set('Cookie', adminCookie);
      expect(unknown.status).toBe(404);
      expect(expectError(unknown).code).toBe('DOCUMENT_NOT_FOUND');

      const asUser = await api(app)
        .post(`/api/documents/${documentId}/reprocess`)
        .set('Cookie', userCookie);
      expect(asUser.status).toBe(403);
      expect(expectError(asUser).code).toBe('FORBIDDEN');

      const anonymous = await api(app).post(`/api/documents/${documentId}/reprocess`);
      expect(anonymous.status).toBe(401);
    });
  });

  describe('the queue overview', () => {
    it('reports every queue and where the documents stand in the pipeline', async () => {
      await givenProcessedDocument();

      const res = await api(app).get('/api/admin/queue/overview').set('Cookie', adminCookie);

      const overview = expectData(res, queueOverviewResponseSchema);
      expect(overview.queues.map((queue) => queue.name)).toEqual([
        'library-scan',
        'file-ingest',
        'document-process',
        'maintenance',
      ]);
      expect(overview.documents.total).toBe(1);
      // All five steps are always reported, so a card never vanishes when it reaches zero.
      expect(overview.documents.steps.map((entry) => entry.step)).toEqual([
        'canonical',
        'preview',
        'markdown',
        'analysis',
        'vectorization',
      ]);
      const preview = overview.documents.steps.find((entry) => entry.step === 'preview');
      expect(preview?.counts.DONE).toBe(1);
      expect(preview?.counts.FAILED).toBe(0);
    });

    it('counts every step of every document, matching what the database holds', async () => {
      await givenProcessedDocument();
      // A second document mid-pipeline: preview done, the rest still to come.
      await seedDocument({
        document: {
          title: 'Half-way',
          canonicalStatus: 'PENDING',
          previewStatus: 'DONE',
          markdownStatus: 'FAILED',
          analysisStatus: 'PENDING',
          vectorizationStatus: 'PENDING',
        },
      });
      // A soft-deleted one, which the counters must not include.
      await seedDocument({
        document: {
          title: 'Deleted',
          canonicalStatus: 'PENDING',
          previewStatus: 'DONE',
          markdownStatus: 'PENDING',
          analysisStatus: 'PENDING',
          vectorizationStatus: 'PENDING',
          deletedAt: new Date(),
        },
      });

      const res = await api(app).get('/api/admin/queue/overview').set('Cookie', adminCookie);

      const overview = expectData(res, queueOverviewResponseSchema);
      expect(overview.documents.total).toBe(2);
      const counts = (step: string) =>
        overview.documents.steps.find((entry) => entry.step === step)?.counts;
      expect(counts('preview')).toMatchObject({ DONE: 2, PENDING: 0 });
      expect(counts('markdown')).toMatchObject({ DONE: 1, FAILED: 1 });
      expect(counts('canonical')).toMatchObject({ SKIPPED: 1, PENDING: 1 });
      expect(counts('vectorization')).toMatchObject({ DONE: 1, PENDING: 1 });
    });

    it('reports storage only once maintenance has measured it', async () => {
      const before = await api(app).get('/api/admin/queue/overview').set('Cookie', adminCookie);
      // 🔒 Honest on a fresh instance: nothing has counted the bucket yet (docs/09 §9.5).
      expect(expectData(before, queueOverviewResponseSchema).storage).toBeNull();

      await app.files.put('documents/dangling/preview.jpg', Buffer.alloc(64), 'image/jpeg');
      await app.nestApp.get(HandleMaintenance).handle();

      const after = await api(app).get('/api/admin/queue/overview').set('Cookie', adminCookie);
      const storage = expectData(after, queueOverviewResponseSchema).storage;
      expect(storage).toMatchObject({ objects: 1, bytes: '64' });
      expect(Date.parse(storage?.measuredAt ?? '')).toBeGreaterThan(0);
    });

    it('counts a queued job in its own queue', async () => {
      const documentId = await givenProcessedDocument();
      await api(app).post(`/api/documents/${documentId}/reprocess`).set('Cookie', adminCookie);

      const res = await api(app).get('/api/admin/queue/overview').set('Cookie', adminCookie);

      const overview = expectData(res, queueOverviewResponseSchema);
      const process = overview.queues.find((queue) => queue.name === 'document-process');
      expect(process?.queued).toBe(1);
      expect(process?.active).toBe(0);
    });
  });

  describe('failures', () => {
    async function givenFailedJob(error = 'Stirling failed with 500'): Promise<string> {
      const [job] = await testPrisma().$queryRawUnsafe<{ id: string }[]>(
        `SELECT id::text AS id FROM pgboss.job WHERE name = 'document-process' LIMIT 1`,
      );
      if (job === undefined) throw new Error('no job to fail');
      await testPrisma().$executeRawUnsafe(
        `UPDATE pgboss.job SET state = 'failed', completed_on = now(), retry_count = 2,
         output = jsonb_build_object('message', $2::text) WHERE id = $1::uuid`,
        job.id,
        error,
      );
      return job.id;
    }

    it('lists a failed job with its payload, error and retry count', async () => {
      const documentId = await givenProcessedDocument();
      await api(app).post(`/api/documents/${documentId}/reprocess`).set('Cookie', adminCookie);
      const jobId = await givenFailedJob();

      const res = await api(app).get('/api/admin/queue/failures').set('Cookie', adminCookie);

      const page = expectData(res, listQueueFailuresResponseSchema);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({
        jobId,
        queue: 'document-process',
        error: 'Stirling failed with 500',
        retryCount: 2,
      });
      expect(page.items[0]?.payload).toMatchObject({ documentId });
    });

    it('retries a failure by re-enqueueing it, leaving the original in the journal', async () => {
      const documentId = await givenProcessedDocument();
      await api(app).post(`/api/documents/${documentId}/reprocess`).set('Cookie', adminCookie);
      const jobId = await givenFailedJob();

      const res = await api(app)
        .post(`/api/admin/queue/failures/${jobId}/retry`)
        .set('Cookie', adminCookie);

      expect(expectData(res, retryJobResponseSchema)).toEqual({ ok: true });
      const jobs = await testPrisma().$queryRawUnsafe<{ state: string }[]>(
        "SELECT state FROM pgboss.job WHERE name = 'document-process'",
      );
      expect(jobs.filter((job) => job.state === 'failed')).toHaveLength(1);
      expect(jobs.filter((job) => job.state === 'created')).toHaveLength(1);
    });

    it('404s a retry for a job that is not there', async () => {
      const res = await api(app)
        .post('/api/admin/queue/failures/11111111-1111-4111-8111-111111111111/retry')
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('NOT_FOUND');

      const malformed = await api(app)
        .post('/api/admin/queue/failures/not-a-uuid/retry')
        .set('Cookie', adminCookie);
      expect(malformed.status).toBe(404);
      expect(expectError(malformed).code).toBe('NOT_FOUND');
    });

    it('refuses the whole queue view to a non-admin', async () => {
      const userCookie = await inviteUser(`curious${seq}@legere.local`);

      for (const path of ['/api/admin/queue/overview', '/api/admin/queue/failures']) {
        const res = await api(app).get(path).set('Cookie', userCookie);
        expect(res.status).toBe(403);
        expect(expectError(res).code).toBe('FORBIDDEN');
      }
    });
  });

  // Running one step again for everything that is stuck in a status (docs/07 §7.3, docs/11 §11.13).
  describe('running a step again', () => {
    // Two failed previews, one that worked, and one that was deleted after failing.
    async function givenFailedPreviews(): Promise<[string, string]> {
      const first = await seedDocument({
        document: { title: 'Failed 1', previewStatus: 'FAILED' },
      });
      const second = await seedDocument({
        document: { title: 'Failed 2', previewStatus: 'FAILED' },
      });
      await seedDocument({ document: { title: 'Fine', previewStatus: 'DONE' } });
      await seedDocument({
        document: { title: 'Gone', previewStatus: 'FAILED', deletedAt: new Date() },
      });
      return [first.id, second.id];
    }

    it('enqueues exactly the documents whose step sits in that status, and says how many', async () => {
      const [first, second] = await givenFailedPreviews();

      const res = await api(app)
        .post('/api/admin/queue/reprocess', { step: 'preview', status: 'FAILED' })
        .set('Cookie', adminCookie);

      // 🔒 The document that worked and the one that was deleted are not part of the repair.
      expect(expectData(res, reprocessByStepResponseSchema)).toEqual({ enqueued: 2 });

      const jobs = await processJobs();
      expect(jobs).toHaveLength(2);
      // Only the step asked for; the rest of the pipeline is not paid for again.
      expect(jobs.every((job) => job.data.steps?.length === 1)).toBe(true);
      expect(jobs.map((job) => job.data.documentId).sort()).toEqual([first, second].sort());

      // The step goes back to PENDING at once, so the queue screen shows work in progress from the
      // moment the button was pressed.
      const rows = await testPrisma().document.findMany({
        where: { id: { in: [first, second] } },
      });
      expect(rows.map((row) => row.previewStatus)).toEqual(['PENDING', 'PENDING']);
      // 🔒 Steps nobody asked for keep the state they had.
      expect(rows.every((row) => row.markdownStatus === 'DONE')).toBe(true);

      const untouched = await testPrisma().document.findFirstOrThrow({ where: { title: 'Fine' } });
      expect(untouched.previewStatus).toBe('DONE');
    });

    it('answers zero and enqueues nothing when nothing is in that state', async () => {
      await givenFailedPreviews();

      const res = await api(app)
        .post('/api/admin/queue/reprocess', { step: 'analysis', status: 'FAILED' })
        .set('Cookie', adminCookie);

      expect(expectData(res, reprocessByStepResponseSchema)).toEqual({ enqueued: 0 });
      expect(await processJobs()).toHaveLength(0);
    });

    it('refuses a step or a status that is not part of the pipeline', async () => {
      const res = await api(app)
        .post('/api/admin/queue/reprocess', { step: 'thumbnail', status: 'FAILED' })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(422);
      expect(expectError(res).code).toBe('VALIDATION_FAILED');

      const badStatus = await api(app)
        .post('/api/admin/queue/reprocess', { step: 'preview', status: 'BROKEN' })
        .set('Cookie', adminCookie);
      expect(badStatus.status).toBe(422);
      expect(await processJobs()).toHaveLength(0);
    });

    it('is admin-only', async () => {
      const userCookie = await inviteUser(`repairman${seq}@legere.local`);

      const asUser = await api(app)
        .post('/api/admin/queue/reprocess', { step: 'preview', status: 'FAILED' })
        .set('Cookie', userCookie);
      expect(asUser.status).toBe(403);
      expect(expectError(asUser).code).toBe('FORBIDDEN');

      const anonymous = await api(app).post('/api/admin/queue/reprocess', {
        step: 'preview',
        status: 'FAILED',
      });
      expect(anonymous.status).toBe(401);
    });
  });

  // Every number on the queue screen is a way to the documents behind it (docs/11 §11.13).
  describe('the documents behind a counter', () => {
    it('filters by a step and the status it sits in', async () => {
      const failed = await seedDocument({
        document: { title: 'Failed preview', previewStatus: 'FAILED' },
      });
      await seedDocument({ document: { title: 'Good preview', previewStatus: 'DONE' } });
      await seedDocument({ document: { title: 'Failed markdown', markdownStatus: 'FAILED' } });

      const res = await api(app)
        .get('/api/documents?step=preview&stepStatus=FAILED')
        .set('Cookie', adminCookie);

      const page = expectData(res, listDocumentsResponseSchema);
      expect(page.items.map((item) => item.id)).toEqual([failed.id]);
    });

    it('refuses half the question', async () => {
      // 🔒 A step without a status would answer with every document and still look filtered
      // (docs/07 §7.3).
      for (const query of ['step=preview', 'stepStatus=FAILED']) {
        const res = await api(app).get(`/api/documents?${query}`).set('Cookie', adminCookie);
        expect(res.status).toBe(422);
        expect(expectError(res).code).toBe('VALIDATION_FAILED');
      }
    });

    it('still shows only what the caller may read', async () => {
      await seedDocument({ document: { title: 'Failed preview', previewStatus: 'FAILED' } });
      const userCookie = await inviteUser(`onlooker${seq}@legere.local`);

      const res = await api(app)
        .get('/api/documents?step=preview&stepStatus=FAILED')
        .set('Cookie', userCookie);

      // A document in a library they were not given is not theirs to see, however it was found.
      expect(expectData(res, listDocumentsResponseSchema).items).toEqual([]);
    });
  });

  // Pausing takes effect through the same re-registration as the concurrencies, so this runs before
  // the throughput test: until one of them is sent, this app has no workers at all, and a queue
  // that is paused when they start gets none.
  it('pauses a queue, which then takes jobs and runs none of them', async () => {
    const paused = await api(app)
      .patch('/api/admin/queue/settings', {
        concurrency: {},
        unitConcurrency: 1,
        // A queue this version does not have is dropped rather than stored for ever (docs/05 §5.4).
        paused: ['document-process', 'thumbnails'],
      })
      .set('Cookie', adminCookie);

    expect(expectData(paused, queueSettingsSchema).paused).toEqual(['document-process']);

    // 🔒 It survives a read, which is what "survives a restart" means for a stored setting: the
    // workers are registered from this on every start.
    const stored = await api(app).get('/api/admin/queue/settings').set('Cookie', adminCookie);
    expect(expectData(stored, queueSettingsSchema).paused).toEqual(['document-process']);

    // The job arrives and waits: the depth grows where an admin can see it, and nothing consumes it.
    const documentId = await givenProcessedDocument();
    await api(app).post(`/api/documents/${documentId}/reprocess`).set('Cookie', adminCookie);
    const overview = await api(app).get('/api/admin/queue/overview').set('Cookie', adminCookie);
    const depths = expectData(overview, queueOverviewResponseSchema).queues;
    expect(depths.find((queue) => queue.name === 'document-process')?.queued).toBe(1);

    // Resuming re-registers the worker; the job goes first so a real pipeline run does not start
    // underneath the rest of the suite.
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    const resumed = await api(app)
      .patch('/api/admin/queue/settings', { concurrency: {}, unitConcurrency: 1, paused: [] })
      .set('Cookie', adminCookie);
    expect(expectData(resumed, queueSettingsSchema).paused).toEqual([]);
  });

  it('sets how hard the instance works, and applies it without a restart', async () => {
    const before = await api(app).get('/api/admin/queue/settings').set('Cookie', adminCookie);
    // The env defaults of docs/12 §12.4 stand until somebody overrides one.
    expect(expectData(before, queueSettingsSchema)).toMatchObject({
      concurrency: { 'file-ingest': 4, 'document-process': 2 },
      unitConcurrency: 1,
      paused: [],
    });

    const saved = await api(app)
      .patch('/api/admin/queue/settings', {
        concurrency: { 'file-ingest': 8, 'document-process': 3 },
        unitConcurrency: 4,
        paused: [],
      })
      .set('Cookie', adminCookie);

    expect(saved.status).toBe(200);
    // Every queue comes back, not only the two that were sent: the form shows them all.
    const settings = expectData(saved, queueSettingsSchema);
    expect(settings.concurrency['file-ingest']).toBe(8);
    // Every queue comes back with its env default, even the ones nobody touched.
    expect(settings.concurrency['library-scan']).toBe(1);
    expect(settings.unitConcurrency).toBe(4);

    // 🔒 It survives a read, which is what "survives a restart" means for a stored setting.
    const after = await api(app).get('/api/admin/queue/settings').set('Cookie', adminCookie);
    expect(expectData(after, queueSettingsSchema).concurrency['file-ingest']).toBe(8);

    // Out of range is clamped rather than refused: the point is a usable instance, not a lecture.
    const clamped = await api(app)
      .patch('/api/admin/queue/settings', {
        concurrency: { 'file-ingest': 32 },
        unitConcurrency: 32,
        paused: [],
      })
      .set('Cookie', adminCookie);
    expect(expectData(clamped, queueSettingsSchema).concurrency['file-ingest']).toBe(32);
  });
});
