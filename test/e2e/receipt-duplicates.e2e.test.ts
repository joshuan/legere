import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PdfToolbox } from '../../src/server/application/ports/pdf-toolbox';
import { toBuffer } from '../../src/server/application/ports/binary-source';
import { JobQueue } from '../../src/server/application/ports/job-queue';
import { UnitOfWork } from '../../src/server/application/ports/unit-of-work';
import { MAX_RECEIPT_MERGE_BYTES } from '../../src/server/application/receipts/review-receipt-duplicates';
import { ReceiptRepository } from '../../src/server/domain/repositories/receipt.repository';
import { FileRepository } from '../../src/server/domain/repositories/file.repository';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  receiptDuplicatePageSchema,
  receiptDuplicatePairSchema,
  receiptReviewPageSchema,
  receiptReviewSchema,
  type ReceiptDuplicatePair,
  type ReceiptReviewAction,
} from '../../src/shared/contracts/receipt-duplicates';
import {
  receiptArtifactUrlSchema,
  receiptDetailSchema,
  listReceiptsResponseSchema,
} from '../../src/shared/contracts/receipts';
import {
  createApiTokenResponseSchema,
  createInviteResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, tokenFromFragmentUrl, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData } from '../helpers/http';

const ROOT = '/api/receipts/duplicates';
const VALUES = {
  vendor: 'Voli Market',
  purchasedAt: '2026-09-30',
  purchasedTime: '12:10',
  total: { amount: 24.8, currency: 'EUR' },
  receiptNumber: 'AB-123',
  card: '****1234',
  items: [{ name: 'Coffee', quantity: 2, amount: 24.8 }],
};

describe('Receipt duplicate review (e2e)', () => {
  let app: TestApp;
  let cookie: string;
  let ownerId: string;
  let number = 0;
  beforeAll(async () => {
    app = await createTestApp({ uploadMaxBytes: 4096 });
  });
  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    app.files.clear();
    app.emails.reset();
    cookie = await onboard();
    ownerId = (await testPrisma().user.findFirstOrThrow()).id;
    const pdfs = app.nestApp.get(PdfToolbox);
    vi.spyOn(pdfs, 'imagesToPdf').mockImplementation(async (images) =>
      Buffer.concat([
        Buffer.from('%PDF-image:'),
        ...(await Promise.all(images.map((image) => toBuffer(image.body)))),
      ]),
    );
    vi.spyOn(pdfs, 'mergePdfs').mockImplementation(async (parts) =>
      Buffer.concat(await Promise.all(parts.map((part) => toBuffer(part)))),
    );
    vi.spyOn(pdfs, 'pdfPageCount').mockResolvedValue(2);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
  });

  async function onboard(inviteToken?: string) {
    const email = `review-${number++}@legere.local`;
    await api(app).post('/api/auth/register/start', { email, inviteToken });
    const verify = expectData(
      await api(app).post('/api/auth/register/verify', {
        email,
        code: app.emails.lastCodeFor(email),
        inviteToken,
      }),
      registerVerifyResponseSchema,
    );
    const response = await api(app).post('/api/auth/register/complete', {
      ticket: verify.ticket,
      password: 'a-decent-passphrase',
    });
    const sid = cookieNamed(response, 'sid');
    if (sid === undefined) throw new Error('Missing session');
    return sid;
  }
  async function otherUser() {
    const invite = expectData(
      await api(app).post('/api/admin/invites', { role: 'USER' }).set('Cookie', cookie),
      createInviteResponseSchema,
    );
    const session = await onboard(tokenFromFragmentUrl(invite.url));
    const user = await testPrisma().user.findFirstOrThrow({
      where: { role: 'USER' },
      orderBy: { createdAt: 'desc' },
    });
    return { cookie: session, id: user.id };
  }
  async function seed(values: Record<string, unknown> = VALUES, owner = ownerId, pdf = false) {
    const fileId = randomUUID();
    const body = Buffer.from(`${pdf ? '%PDF-original' : 'image-original'}-${number++}`);
    const ext = pdf ? 'pdf' : 'jpg';
    const key = `files/${fileId}/original.${ext}`;
    await app.files.put(key, body, pdf ? 'application/pdf' : 'image/jpeg');
    const { file } = await app.nestApp.get(FileRepository).findOrCreateByContentHash({
      id: fileId,
      contentHash: createHash('sha256').update(body).digest('hex'),
      origin: 'MANAGED',
      storageKey: key,
      mimeType: pdf ? 'application/pdf' : 'image/jpeg',
      ext,
      name: `receipt-${number}.${ext}`,
      sizeBytes: BigInt(body.length),
    });
    const repository = app.nestApp.get(ReceiptRepository);
    const receipt = await repository.create({
      fileId: file.id,
      createdById: owner,
      sourceText: `Source ${number}`,
    });
    await repository.updateProcessing(receipt.id, {
      previewStatus: 'DONE',
      extractionStatus: 'DONE',
      pageCount: 1,
      extracted: { schema: { slug: 'receipt', version: 3 }, values, confidence: 95 },
    });
    return { id: receipt.id, fileId, key, body };
  }
  async function compare(firstId: string, secondId: string, session = cookie) {
    return expectData(
      await api(app)
        .get(`${ROOT}/compare?firstId=${firstId}&secondId=${secondId}`)
        .set('Cookie', session),
      receiptDuplicatePairSchema,
    );
  }
  async function list(session = cookie, cursor?: string) {
    return expectData(
      await api(app)
        .get(`${ROOT}${cursor === undefined ? '' : `?cursor=${cursor}`}`)
        .set('Cookie', session),
      receiptDuplicatePageSchema,
    );
  }
  function input(
    pair: ReceiptDuplicatePair,
    action: ReceiptReviewAction = 'DISMISS',
    reverse = false,
  ) {
    return {
      operationId: randomUUID(),
      firstId: pair.first.id,
      secondId: pair.second.id,
      revision: pair.revision,
      action,
      reverse,
    };
  }
  async function liveIds() {
    return (
      await testPrisma().receipt.findMany({
        where: { reviewState: 'ACTIVE', archiveItem: { deletedAt: null } },
      })
    )
      .map((row) => row.id)
      .sort();
  }

  it('routes static candidates before ids, rejects weak matches and compares unrecognized pairs manually', async () => {
    const first = await seed();
    const second = await seed();
    const third = await seed({
      ...VALUES,
      vendor: 'Another Shop',
      receiptNumber: 'OTHER',
      card: '5678',
    });
    const fourth = await seed({ ...VALUES, total: null });
    const suggestions = await list();
    expect(suggestions.items).toHaveLength(1);
    expect(new Set([suggestions.items[0]?.first.id, suggestions.items[0]?.second.id])).toEqual(
      new Set([first.id, second.id]),
    );
    expect(suggestions.items[0]?.kind).toBe('duplicate');
    expect((await compare(third.id, fourth.id)).kind).toBe('manual');
    await api(app)
      .get(`${ROOT}/compare?firstId=${first.id}&secondId=${first.id}`)
      .set('Cookie', cookie)
      .expect(422);
  });

  it('remembers dismissal, replays retries, lists history, and allows undo followed by a fresh decision', async () => {
    const a = await seed();
    const b = await seed();
    const pair = await compare(a.id, b.id);
    const command = input(pair);
    const review = expectData(
      await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect((await list()).items).toEqual([]);
    expectData(
      await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(await testPrisma().receiptReview.count()).toBe(1);
    expect(await liveIds()).toEqual([a.id, b.id].sort());
    expect(
      expectData(
        await api(app).get(`${ROOT}/history`).set('Cookie', cookie),
        receiptReviewPageSchema,
      ).items[0]?.id,
    ).toBe(review.id);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', cookie).expect(200);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', cookie).expect(200);
    expect((await list()).items).toHaveLength(1);
    await api(app)
      .post(`${ROOT}/resolve`, input(await compare(a.id, b.id)))
      .set('Cookie', cookie)
      .expect(200);
    expect((await list()).items).toEqual([]);
    expect(await testPrisma().receiptReview.count()).toBe(2);
  });

  async function detail(id: string, session = cookie) {
    return expectData(
      await api(app).get(`/api/receipts/${id}`).set('Cookie', session),
      receiptDetailSchema,
    );
  }

  it('documents receipt reads with their own token scheme and replacement contract', async () => {
    const spec = z
      .object({
        paths: z.record(
          z.object({ get: z.object({ security: z.unknown() }).passthrough() }).passthrough(),
        ),
        components: z.object({
          securitySchemes: z.record(z.unknown()),
          schemas: z.record(z.unknown()),
        }),
      })
      .parse((await request(app.baseUrl).get('/api/openapi.json').expect(200)).body);
    for (const suffix of ['', '/original', '/download', '/thumbnail', '/pages/{page}']) {
      expect(spec.paths[`/api/receipts/{id}${suffix}`]?.get.security).toEqual([
        { personalReadToken: [] },
      ]);
    }
    expect(spec.components.securitySchemes.personalReadToken).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(spec.components.schemas.ReceiptReference).toMatchObject({
      required: ['state', 'replacementId', 'restoredReceiptIds', 'reviewId'],
      properties: { state: { enum: ['ACTIVE', 'REPLACED', 'MERGE_UNDONE'] } },
    });
  });

  it('keeps chained references readable to READ clients without replacing their data or widening ownership', async () => {
    const a = await seed();
    const b = await seed();
    const c = await seed();
    const pair = await compare(a.id, b.id);
    const first = expectData(
      await api(app).post(`${ROOT}/resolve`, input(pair, 'KEEP_SECOND')).set('Cookie', cookie),
      receiptReviewSchema,
    );
    const original = await detail(pair.first.id);
    expect(original.reference).toEqual({
      state: 'REPLACED',
      replacementId: pair.second.id,
      restoredReceiptIds: [],
      reviewId: first.id,
    });
    expect(original.id).toBe(pair.first.id);
    expect(original.extracted).toEqual(pair.first.extracted);
    expect(
      (await testPrisma().archiveItem.findUniqueOrThrow({ where: { id: pair.first.id } }))
        .deletedAt,
    ).toBeNull();
    const nextPair = await compare(pair.second.id, c.id);
    const action = nextPair.first.id === c.id ? 'KEEP_FIRST' : 'KEEP_SECOND';
    const second = expectData(
      await api(app).post(`${ROOT}/resolve`, input(nextPair, action)).set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect((await detail(pair.first.id)).reference.replacementId).toBe(pair.second.id);
    expect((await detail(pair.second.id)).reference.replacementId).toBe(c.id);
    const token = expectData(
      await api(app)
        .post('/api/me/api-tokens', { name: 'Receipt reference reader', scope: 'READ' })
        .set('Cookie', cookie),
      createApiTokenResponseSchema,
    );
    const read = expectData(
      await api(app)
        .get(`/api/receipts/${pair.first.id}`)
        .set('Authorization', `Bearer ${token.token}`),
      receiptDetailSchema,
    );
    expect(read.reference).toEqual(original.reference);
    for (const suffix of ['original', 'download', 'thumbnail', 'pages/0']) {
      const artifact = expectData(
        await api(app)
          .get(`/api/receipts/${pair.first.id}/${suffix}`)
          .set('Authorization', `Bearer ${token.token}`),
        receiptArtifactUrlSchema,
      );
      expect(artifact.url).toContain(
        suffix === 'original' || suffix === 'download'
          ? pair.first.id === a.id
            ? a.fileId
            : b.fileId
          : pair.first.id,
      );
    }
    const user = await otherUser();
    await api(app).get(`/api/receipts/${pair.first.id}`).set('Cookie', user.cookie).expect(404);
    await api(app)
      .get(`/api/receipts/${pair.first.id}/original`)
      .set('Cookie', user.cookie)
      .expect(404);
    await api(app).delete(`/api/receipts/${pair.first.id}`).set('Cookie', cookie).expect(409);
    await api(app)
      .patch(`/api/archive-items/${pair.first.id}/kind`, { kind: 'DOCUMENT' })
      .set('Cookie', cookie)
      .expect(409);
    await api(app)
      .get(`${ROOT}/compare?firstId=${pair.first.id}&secondId=${c.id}`)
      .set('Cookie', cookie)
      .expect(409);
    const shelf = expectData(
      await api(app).get('/api/receipts').set('Cookie', cookie),
      listReceiptsResponseSchema,
    );
    expect(shelf.items.map((item) => item.id)).toEqual([c.id]);
    await api(app).post(`${ROOT}/history/${second.id}/undo`).set('Cookie', cookie).expect(200);
    await api(app).post(`${ROOT}/history/${first.id}/undo`).set('Cookie', cookie).expect(200);
    expect((await detail(pair.first.id)).reference).toEqual({
      state: 'ACTIVE',
      replacementId: null,
      restoredReceiptIds: [],
      reviewId: null,
    });
  });

  it('keeps a source readable when its active replacement is explicitly deleted', async () => {
    const a = await seed();
    const b = await seed();
    const pair = await compare(a.id, b.id);
    await api(app)
      .post(`${ROOT}/resolve`, input(pair, 'KEEP_SECOND'))
      .set('Cookie', cookie)
      .expect(200);
    await api(app).delete(`/api/receipts/${pair.second.id}`).set('Cookie', cookie).expect(200);
    expect((await detail(pair.first.id)).reference).toMatchObject({
      state: 'REPLACED',
      replacementId: null,
    });
    await api(app).get(`/api/receipts/${pair.first.id}/original`).set('Cookie', cookie).expect(200);
  });

  it('keeps one, preserves hidden data and downloads, and restores it through history', async () => {
    const a = await seed();
    const b = await seed();
    const pair = await compare(a.id, b.id);
    const originals = app.files.keys();
    const review = expectData(
      await api(app).post(`${ROOT}/resolve`, input(pair, 'KEEP_SECOND')).set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(await liveIds()).toEqual([pair.second.id]);
    await api(app).get(`/api/receipts/${pair.first.id}`).set('Cookie', cookie).expect(200);
    const download = expectData(
      await api(app).get(`${ROOT}/history/${review.id}/originals/0`).set('Cookie', cookie),
      receiptArtifactUrlSchema,
    );
    expect(download.url).toContain('/original.jpg');
    expect(download.url).toContain('attachment');
    await api(app)
      .get(`${ROOT}/history/${review.id}/originals/2`)
      .set('Cookie', cookie)
      .expect(404);
    expect(app.files.keys()).toEqual(originals);
    expect(await testPrisma().file.count({ where: { trashedAt: { not: null } } })).toBe(0);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', cookie).expect(200);
    expect(await liveIds()).toEqual([a.id, b.id].sort());
  });

  it('merges original image and PDF bytes in the selected order, queues one new receipt, replays and remerges after undo', async () => {
    const a = await seed();
    const b = await seed({ ...VALUES, items: [] }, ownerId, true);
    const pair = await compare(a.id, b.id);
    expect(pair.kind).toBe('parts');
    const merge = vi.spyOn(app.nestApp.get(PdfToolbox), 'mergePdfs');
    const command = input(pair, 'MERGE', true);
    const review = expectData(
      await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie),
      receiptReviewSchema,
    );
    const resultId = receiptReviewSchema.parse(review).resultId;
    if (resultId === null) throw new Error('Merge has no result');
    const result = await app.nestApp.get(ReceiptRepository).findById(resultId);
    if (result?.file.storageKey == null) throw new Error('Missing merged original');
    const ordered = [a, b].sort((left, right) => right.id.localeCompare(left.id));
    expect(app.files.get(result.file.storageKey).body).toEqual(
      Buffer.concat(
        ordered.map((receipt) =>
          receipt.id === a.id ? Buffer.concat([Buffer.from('%PDF-image:'), a.body]) : b.body,
        ),
      ),
    );
    expect(result).toMatchObject({
      createdById: ownerId,
      previewStatus: 'QUEUED',
      extractionStatus: 'QUEUED',
    });
    expect(await liveIds()).toEqual([resultId]);
    expect(app.files.get(a.key).body).toEqual(a.body);
    expect(app.files.get(b.key).body).toEqual(b.body);
    expect(await testPrisma().document.count()).toBe(0);
    expect(
      await testPrisma().$queryRaw`SELECT data FROM pgboss.job WHERE name = 'receipt-process'`,
    ).toEqual([{ data: { receiptId: resultId } }]);
    await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie).expect(200);
    expect(merge).toHaveBeenCalledTimes(1);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', cookie).expect(200);
    expect(await liveIds()).toEqual([a.id, b.id].sort());
    expect((await detail(resultId)).processing).toBe(false);
    expect((await detail(resultId)).reference).toEqual({
      state: 'MERGE_UNDONE',
      replacementId: null,
      restoredReceiptIds: [pair.second.id, pair.first.id],
      reviewId: review.id,
    });
    const preservedPdf = expectData(
      await api(app).get(`/api/receipts/${resultId}/original`).set('Cookie', cookie),
      receiptArtifactUrlSchema,
    );
    expect(preservedPdf.url).toContain(result.fileId);
    // The hidden result's old job can have completed and expired without changing its checkpoint.
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    const again = expectData(
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'MERGE', true))
        .set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(again.resultId).toBe(resultId);
    expect((await detail(resultId)).reference.state).toBe('ACTIVE');
    expect((await detail(a.id)).reference.replacementId).toBe(resultId);
    expect((await detail(b.id)).reference.replacementId).toBe(resultId);
    expect(
      await testPrisma().$queryRaw`SELECT data FROM pgboss.job WHERE name = 'receipt-process'`,
    ).toEqual([{ data: { receiptId: resultId } }]);
    expect(await liveIds()).toEqual([resultId]);
    expect(app.files.keys()).toHaveLength(3);
  });

  it('rejects stale confirmation after extraction changes and lets changed dismissed facts reappear', async () => {
    const a = await seed();
    const b = await seed();
    const pair = await compare(a.id, b.id);
    await api(app).post(`${ROOT}/resolve`, input(pair)).set('Cookie', cookie).expect(200);
    await app.nestApp.get(ReceiptRepository).updateProcessing(a.id, {
      extracted: {
        schema: { slug: 'receipt', version: 3 },
        values: { ...VALUES, vendorAddress: 'New address' },
        confidence: 99,
      },
    });
    const response = await api(app)
      .post(`${ROOT}/resolve`, input(pair, 'KEEP_FIRST'))
      .set('Cookie', cookie);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'RECEIPT_CHANGED' } });
    expect((await list()).items).toHaveLength(1);
    expect(await liveIds()).toHaveLength(2);
  });

  it('requires later decisions to be undone first, including when their timestamps are identical', async () => {
    const a = await seed();
    const b = await seed();
    const c = await seed();
    const first = expectData(
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'KEEP_FIRST'))
        .set('Cookie', cookie),
      receiptReviewSchema,
    );
    if (first.resultId === null) throw new Error('Missing survivor');
    const second = expectData(
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(first.resultId, c.id), 'KEEP_SECOND'))
        .set('Cookie', cookie),
      receiptReviewSchema,
    );
    await testPrisma().receiptReview.updateMany({
      data: { createdAt: new Date('2026-10-01T00:00:00Z') },
    });
    expect(
      (await api(app).post(`${ROOT}/history/${first.id}/undo`).set('Cookie', cookie)).body,
    ).toMatchObject({ error: { code: 'RECEIPT_REVIEW_DEPENDENCY' } });
    await api(app).post(`${ROOT}/history/${second.id}/undo`).set('Cookie', cookie).expect(200);
    await api(app).post(`${ROOT}/history/${first.id}/undo`).set('Cookie', cookie).expect(200);
    expect(await liveIds()).toHaveLength(3);
  });

  it('rolls back metadata, queue and hidden sources and removes the new object if enqueue fails', async () => {
    const a = await seed();
    const b = await seed();
    const keys = app.files.keys();
    vi.spyOn(app.nestApp.get(JobQueue), 'enqueueAfterTx').mockRejectedValueOnce(
      new Error('Queue unavailable'),
    );
    await api(app)
      .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'MERGE'))
      .set('Cookie', cookie)
      .expect(500);
    expect(await liveIds()).toHaveLength(2);
    expect(await testPrisma().file.count()).toBe(2);
    expect(await testPrisma().receiptReview.count()).toBe(0);
    expect(app.files.keys()).toEqual(keys);
  });

  it('preserves a committed PDF when the transaction acknowledgement is lost', async () => {
    const a = await seed();
    const b = await seed();
    const uow = app.nestApp.get(UnitOfWork);
    const run = uow.run.bind(uow);
    vi.spyOn(uow, 'run').mockImplementationOnce(async (work) => {
      await run(work);
      throw new Error('Lost commit acknowledgement');
    });
    const command = input(await compare(a.id, b.id), 'MERGE');
    await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie).expect(500);
    const review = expectData(
      await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(await liveIds()).toEqual([review.resultId]);
    expect(app.files.keys()).toHaveLength(3);
  });

  it('refuses an in-flight source change after PDF assembly without hiding receipts', async () => {
    const a = await seed();
    const b = await seed();
    vi.spyOn(app.nestApp.get(PdfToolbox), 'mergePdfs').mockImplementationOnce(async () => {
      await app.nestApp
        .get(ReceiptRepository)
        .updateProcessing(a.id, { extractionStatus: 'QUEUED' });
      return Buffer.from('%PDF-changed');
    });
    await api(app)
      .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'MERGE'))
      .set('Cookie', cookie)
      .expect(409);
    expect(await liveIds()).toHaveLength(2);
    expect(app.files.keys()).toHaveLength(2);
  });

  it('bounds page counts, input bytes and output bytes and leaves originals intact on conversion failure', async () => {
    const a = await seed();
    const b = await seed();
    const repository = app.nestApp.get(ReceiptRepository);
    await repository.updateProcessing(a.id, { pageCount: 100 });
    let pair = await compare(a.id, b.id);
    expect(pair.mergeBlocked).toBe('pages');
    await api(app).post(`${ROOT}/resolve`, input(pair, 'MERGE')).set('Cookie', cookie).expect(409);
    await repository.updateProcessing(a.id, { pageCount: 1 });
    await testPrisma().file.update({
      where: { id: a.fileId },
      data: { sizeBytes: BigInt(MAX_RECEIPT_MERGE_BYTES) },
    });
    pair = await compare(a.id, b.id);
    expect(pair.mergeBlocked).toBe('size');
    await api(app).post(`${ROOT}/resolve`, input(pair, 'MERGE')).set('Cookie', cookie).expect(409);
    await testPrisma().file.update({
      where: { id: a.fileId },
      data: { sizeBytes: BigInt(a.body.length) },
    });
    pair = await compare(a.id, b.id);
    vi.spyOn(app.nestApp.get(PdfToolbox), 'mergePdfs')
      .mockResolvedValueOnce(Buffer.alloc(4097))
      .mockRejectedValueOnce(new Error('Converter unavailable'));
    await api(app).post(`${ROOT}/resolve`, input(pair, 'MERGE')).set('Cookie', cookie).expect(409);
    await api(app).post(`${ROOT}/resolve`, input(pair, 'MERGE')).set('Cookie', cookie).expect(500);
    vi.spyOn(app.nestApp.get(PdfToolbox), 'pdfPageCount').mockResolvedValueOnce(1);
    await api(app).post(`${ROOT}/resolve`, input(pair, 'MERGE')).set('Cookie', cookie).expect(409);
    expect(await liveIds()).toHaveLength(2);
    expect(app.files.keys()).toHaveLength(2);
  });

  it('limits access to the owner or admin, separates owners, enforces sessions and CSRF', async () => {
    const a = await seed();
    const b = await seed();
    const user = await otherUser();
    expect((await list(user.cookie)).items).toEqual([]);
    await api(app).get(ROOT).expect(401);
    await api(app)
      .get(`${ROOT}/compare?firstId=${a.id}&secondId=${b.id}`)
      .set('Cookie', user.cookie)
      .expect(404);
    const owned = await seed(VALUES, user.id);
    await api(app)
      .get(`${ROOT}/compare?firstId=${a.id}&secondId=${owned.id}`)
      .set('Cookie', cookie)
      .expect(404);
    const command = input(await compare(a.id, b.id));
    await api(app).post(`${ROOT}/resolve`, command).set('Cookie', user.cookie).expect(404);
    await request(app.baseUrl)
      .post(`${ROOT}/resolve`)
      .set('Cookie', cookie)
      .send(command)
      .expect(403);
    const token = expectData(
      await api(app)
        .post('/api/me/api-tokens', { name: 'Review reader', scope: 'READ' })
        .set('Cookie', cookie),
      createApiTokenResponseSchema,
    );
    await api(app).get(ROOT).set('Authorization', `Bearer ${token.token}`).expect(200);
    await api(app)
      .post(`${ROOT}/resolve`, command)
      .set('Authorization', `Bearer ${token.token}`)
      .expect(403);
    const review = expectData(
      await api(app).post(`${ROOT}/resolve`, command).set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(
      expectData(
        await api(app).get(`${ROOT}/history`).set('Cookie', user.cookie),
        receiptReviewPageSchema,
      ).items,
    ).toEqual([]);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', user.cookie).expect(404);
    await api(app)
      .get(`${ROOT}/history/${review.id}/originals/0`)
      .set('Cookie', user.cookie)
      .expect(404);
    await request(app.baseUrl)
      .post(`${ROOT}/history/${review.id}/undo`)
      .set('Cookie', cookie)
      .expect(403);
  });

  it('paginates bounded candidate scans without transitive grouping or skipping pairs', async () => {
    for (let index = 0; index < 22; index++) await seed();
    const first = await list();
    expect(first.checkedPairs).toBe(200);
    expect(first.items).toHaveLength(200);
    expect(first.nextCursor).not.toBeNull();
    const second = await list(cookie, first.nextCursor ?? '');
    expect(second.items).toHaveLength(31);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((pair) => `${pair.first.id}:${pair.second.id}`))
        .size,
    ).toBe(231);
    expect((await list(cookie, 'bad-cursor')).items).toHaveLength(200);
  });
  it('serializes conflicting review, deletion and conversion against a held source lock', async () => {
    const a = await seed();
    const b = await seed();
    const pair = await compare(a.id, b.id);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce = () => {};
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const held = testPrisma().$transaction(async (tx) => {
      await app.nestApp.get(ReceiptRepository).lockByIds([a.id, b.id], tx);
      announce();
      await gate;
    });
    await ready;
    try {
      for (const response of [
        await api(app).post(`${ROOT}/resolve`, input(pair, 'KEEP_FIRST')).set('Cookie', cookie),
        await api(app).delete(`/api/receipts/${a.id}`).set('Cookie', cookie),
        await api(app)
          .patch(`/api/archive-items/${a.id}/kind`, { kind: 'DOCUMENT' })
          .set('Cookie', cookie),
      ]) {
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ error: { code: 'RECEIPT_CHANGED' } });
      }
      expect(await liveIds()).toHaveLength(2);
    } finally {
      release();
      await held;
    }
  });

  it('accepts only one conflicting decision and bounds simultaneous PDF assemblies', async () => {
    const a = await seed();
    const b = await seed();
    const pair = await compare(a.id, b.id);
    const answers = await Promise.all([
      api(app).post(`${ROOT}/resolve`, input(pair, 'KEEP_FIRST')).set('Cookie', cookie),
      api(app).post(`${ROOT}/resolve`, input(pair, 'KEEP_SECOND')).set('Cookie', cookie),
    ]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(await liveIds()).toHaveLength(1);
    expect(await testPrisma().receiptReview.count()).toBe(1);
    const decision = await testPrisma().receiptReview.findFirstOrThrow();
    await api(app).post(`${ROOT}/history/${decision.id}/undo`).set('Cookie', cookie).expect(200);
    const current = await compare(a.id, b.id);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let announce = () => {};
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    vi.spyOn(app.nestApp.get(PdfToolbox), 'mergePdfs').mockImplementationOnce(async () => {
      announce();
      await gate;
      return Buffer.from('%PDF-bounded');
    });
    const merging = api(app)
      .post(`${ROOT}/resolve`, input(current, 'MERGE'))
      .set('Cookie', cookie)
      .then((value) => value);
    await ready;
    try {
      const refused = await api(app)
        .post(`${ROOT}/resolve`, input(current, 'MERGE'))
        .set('Cookie', cookie);
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ error: { code: 'RECEIPT_MERGE_BUSY' } });
    } finally {
      release();
    }
    expect((await merging).status).toBe(200);
  });

  it("keeps source ownership when an admin combines another owner's receipts", async () => {
    const user = await otherUser();
    const a = await seed(VALUES, user.id);
    const b = await seed(VALUES, user.id);
    const review = expectData(
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'MERGE'))
        .set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(
      await testPrisma().archiveItem.findUnique({ where: { id: review.resultId ?? '' } }),
    ).toMatchObject({ createdById: user.id });
    expect(review.actor.id).toBe(ownerId);
    const history = expectData(
      await api(app).get(`${ROOT}/history`).set('Cookie', user.cookie),
      receiptReviewPageSchema,
    );
    expect(history.items.map((item) => item.id)).toEqual([review.id]);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', user.cookie).expect(200);
  });

  it('restores merge sources after an explicit result deletion without resurrecting that result', async () => {
    const a = await seed();
    const b = await seed();
    const review = expectData(
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'MERGE'))
        .set('Cookie', cookie),
      receiptReviewSchema,
    );
    if (review.resultId === null) throw new Error('Missing result');
    await api(app).delete(`/api/receipts/${review.resultId}`).set('Cookie', cookie).expect(200);
    await api(app).post(`${ROOT}/history/${review.id}/undo`).set('Cookie', cookie).expect(200);
    expect(await liveIds()).toEqual([a.id, b.id].sort());
    expect(
      await testPrisma().archiveItem.findUnique({ where: { id: review.resultId } }),
    ).toBeNull();
    const again = expectData(
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(a.id, b.id), 'MERGE'))
        .set('Cookie', cookie),
      receiptReviewSchema,
    );
    expect(again.resultId).not.toBe(review.resultId);
    expect(await testPrisma().file.count({ where: { trashedAt: { not: null } } })).toBe(0);
  });

  it('paginates history in decision order and ignores malformed or overflowing cursors', async () => {
    const a = await seed();
    const b = await seed();
    const c = await seed();
    for (const second of [b, c])
      await api(app)
        .post(`${ROOT}/resolve`, input(await compare(a.id, second.id)))
        .set('Cookie', cookie)
        .expect(200);
    const first = expectData(
      await api(app).get(`${ROOT}/history?limit=1`).set('Cookie', cookie),
      receiptReviewPageSchema,
    );
    const next = expectData(
      await api(app)
        .get(`${ROOT}/history?limit=1&cursor=${first.nextCursor ?? ''}`)
        .set('Cookie', cookie),
      receiptReviewPageSchema,
    );
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(next.nextCursor).toBeNull();
    const cursor = Buffer.from(`1\u00009999999999999999999\u0000${a.id}`).toString('base64url');
    await api(app).get(`${ROOT}/history?cursor=${cursor}`).set('Cookie', cookie).expect(200);
  });
});
