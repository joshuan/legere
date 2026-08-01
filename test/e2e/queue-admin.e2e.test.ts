import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { reprocessResponseSchema } from '../../src/shared/contracts/documents';
import {
  listQueueFailuresResponseSchema,
  queueOverviewResponseSchema,
  retryJobResponseSchema,
} from '../../src/shared/contracts/queue';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { HandleMaintenance } from '../../src/server/application/jobs/handle-maintenance';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
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
    const document = await testPrisma().document.create({
      data: {
        contentHash: `${seq}`.padStart(64, 'a'),
        source: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 100n,
        title: 'Invoice',
        markdown: 'Amount due',
        canonicalStatus: 'SKIPPED',
        previewStatus: 'DONE',
        markdownStatus: 'DONE',
        categorizationStatus: 'DONE',
        vectorizationStatus: 'DONE',
        processingError: 'preview failed once',
        failedStep: 'preview',
      },
    });
    return document.id;
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
        'categorization',
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
      expect(row.categorizationStatus).toBe('DONE');

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
        'scanset-merge',
        'maintenance',
      ]);
      expect(overview.documents.total).toBe(1);
      // All five steps are always reported, so a card never vanishes when it reaches zero.
      expect(overview.documents.steps.map((entry) => entry.step)).toEqual([
        'canonical',
        'preview',
        'markdown',
        'categorization',
        'vectorization',
      ]);
      const preview = overview.documents.steps.find((entry) => entry.step === 'preview');
      expect(preview?.counts.DONE).toBe(1);
      expect(preview?.counts.FAILED).toBe(0);
    });

    it('counts every step of every document, matching what the database holds', async () => {
      await givenProcessedDocument();
      // A second document mid-pipeline: preview done, the rest still to come.
      await testPrisma().document.create({
        data: {
          contentHash: `${seq}`.padStart(64, 'b'),
          source: 'LIBRARY',
          mimeType: 'application/pdf',
          ext: 'pdf',
          sizeBytes: 10n,
          title: 'Half-way',
          previewStatus: 'DONE',
          markdownStatus: 'FAILED',
        },
      });
      // A soft-deleted one, which the counters must not include.
      await testPrisma().document.create({
        data: {
          contentHash: `${seq}`.padStart(64, 'c'),
          source: 'LIBRARY',
          mimeType: 'application/pdf',
          ext: 'pdf',
          sizeBytes: 10n,
          title: 'Deleted',
          previewStatus: 'DONE',
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
});
