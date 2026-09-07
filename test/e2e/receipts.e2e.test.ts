import request from 'supertest';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import { documentDetailDtoSchema } from '../../src/shared/contracts/documents';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import {
  convertArchiveItemResponseSchema,
  listReceiptsResponseSchema,
  receiptDetailSchema,
  uploadReceiptResponseSchema,
} from '../../src/shared/contracts/receipts';
import {
  listTrashResponseSchema,
  restoreTrashResponseSchema,
} from '../../src/shared/contracts/trash';
import { APP_ORIGIN, api, createTestApp, tokenFromFragmentUrl, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import { cookieNamed, expectData } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const SOURCE_TEXT = '<html><body>Order 42, shop Voli, total EUR 12.40</body></html>';

describe('Receipts (e2e)', () => {
  let app: TestApp;
  let cookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    app.emails.reset();
    app.files.clear();
    seq += 1;
    cookie = await onboard(`receipt-admin-${seq}@legere.local`);
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

  async function receiptImage(): Promise<Buffer> {
    return sharp({
      create: { width: 16, height: 24, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
  }

  async function inviteUser(email: string): Promise<string> {
    const created = await api(app)
      .post('/api/admin/invites', { role: 'USER' })
      .set('Cookie', cookie);
    const token = tokenFromFragmentUrl(expectData(created, createInviteResponseSchema).url);
    await api(app).post('/api/auth/register/start', { email, inviteToken: token });
    const verified = await api(app).post('/api/auth/register/verify', {
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('invited user did not get a session cookie');
    return sid;
  }

  async function uploadReceipt(text = SOURCE_TEXT) {
    const uploaded = await request(app.baseUrl)
      .post('/api/receipts')
      .set('Origin', APP_ORIGIN)
      .set('Cookie', cookie)
      .field('text', text)
      .attach('file', await receiptImage(), {
        filename: 'email-receipt.jpg',
        contentType: 'image/jpeg',
      });
    expect(uploaded.status).toBe(201);
    return expectData(uploaded, uploadReceiptResponseSchema);
  }

  it('accepts an image and noisy caller text as one receipt without creating a document', async () => {
    const answer = await uploadReceipt();
    expect(answer.created).toBe(true);
    expect(answer.receipt).toMatchObject({
      fileName: 'email-receipt.jpg',
      mimeType: 'image/jpeg',
      previewStatus: 'QUEUED',
      extractionStatus: 'QUEUED',
    });

    const detail = expectData(
      await api(app).get(`/api/receipts/${answer.receipt.id}`).set('Cookie', cookie),
      receiptDetailSchema,
    );
    expect(detail.sourceText).toBe(SOURCE_TEXT);

    const listed = expectData(
      await api(app).get('/api/receipts').set('Cookie', cookie),
      listReceiptsResponseSchema,
    );
    expect(listed.items.map((receipt) => receipt.id)).toEqual([answer.receipt.id]);
    expect(await testPrisma().document.findUnique({ where: { id: answer.receipt.id } })).toBeNull();
    expect(
      await testPrisma().archiveItem.findUnique({ where: { id: answer.receipt.id } }),
    ).toMatchObject({ kind: 'RECEIPT' });

    const jobs = await testPrisma().$queryRaw<Array<{ data: { receiptId?: string } }>>`
      SELECT data FROM pgboss.job WHERE name = 'receipt-process'
    `;
    expect(jobs).toEqual([{ data: { receiptId: answer.receipt.id } }]);
    expect(app.files.keys()).toHaveLength(1);
    expect(app.files.keys()[0]).toMatch(/^files\/.+\/original\.jpg$/);
  });

  it("does not disclose another owner's receipt in lists, detail, artifacts or deletion", async () => {
    const uploaded = await uploadReceipt();
    const otherCookie = await inviteUser(`receipt-reader-${seq}@legere.local`);

    const listed = expectData(
      await api(app).get('/api/receipts').set('Cookie', otherCookie),
      listReceiptsResponseSchema,
    );
    expect(listed.items).toEqual([]);
    for (const response of [
      api(app).get(`/api/receipts/${uploaded.receipt.id}`).set('Cookie', otherCookie),
      api(app).get(`/api/receipts/${uploaded.receipt.id}/thumbnail`).set('Cookie', otherCookie),
      api(app).delete(`/api/receipts/${uploaded.receipt.id}`).set('Cookie', otherCookie),
    ]) {
      await response.expect(404);
    }
  });

  it('converts a settled receipt into a document without changing its archive id', async () => {
    const uploaded = await uploadReceipt();
    await testPrisma().receipt.update({
      where: { id: uploaded.receipt.id },
      data: { previewStatus: 'DONE', extractionStatus: 'DONE', pageCount: 1 },
    });

    const converted = expectData(
      await api(app)
        .patch(`/api/archive-items/${uploaded.receipt.id}/kind`, { kind: 'DOCUMENT' })
        .set('Cookie', cookie),
      convertArchiveItemResponseSchema,
    );

    expect(converted).toEqual({ id: uploaded.receipt.id, kind: 'DOCUMENT' });
    expect(
      await api(app).get(`/api/receipts/${uploaded.receipt.id}`).set('Cookie', cookie),
    ).toHaveProperty('status', 404);
    const document = expectData(
      await api(app).get(`/api/documents/${uploaded.receipt.id}`).set('Cookie', cookie),
      documentDetailDtoSchema,
    );
    expect(document).toMatchObject({
      id: uploaded.receipt.id,
      title: 'email-receipt',
      fileCount: 1,
    });
  });

  it('converts a one-file managed image document into a receipt with the same id', async () => {
    const owner = await testPrisma().user.findFirstOrThrow();
    const seeded = await seedDocument({
      document: { title: 'Till receipt', createdById: owner.id },
      files: [
        {
          origin: 'MANAGED',
          storageKey: 'files/conversion/original.png',
          mimeType: 'image/png',
          ext: 'png',
          name: 'till-receipt.png',
        },
      ],
    });

    const converted = expectData(
      await api(app)
        .patch(`/api/archive-items/${seeded.id}/kind`, { kind: 'RECEIPT' })
        .set('Cookie', cookie),
      convertArchiveItemResponseSchema,
    );

    expect(converted).toEqual({ id: seeded.id, kind: 'RECEIPT' });
    const receipt = expectData(
      await api(app).get(`/api/receipts/${seeded.id}`).set('Cookie', cookie),
      receiptDetailSchema,
    );
    expect(receipt).toMatchObject({
      id: seeded.id,
      fileName: 'till-receipt.png',
      previewStatus: 'QUEUED',
      extractionStatus: 'QUEUED',
    });
    expect(await testPrisma().document.findUnique({ where: { id: seeded.id } })).toBeNull();
  });

  it('restores a deleted receipt from the common trash as a receipt', async () => {
    const uploaded = await uploadReceipt();
    const removed = await api(app)
      .delete(`/api/receipts/${uploaded.receipt.id}`)
      .set('Cookie', cookie);
    expect(removed.status).toBe(200);

    const trash = expectData(
      await api(app).get('/api/admin/trash').set('Cookie', cookie),
      listTrashResponseSchema,
    );
    expect(trash.items).toHaveLength(1);
    expect(trash.items[0]).toMatchObject({
      reason: 'RECEIPT_DELETED',
      archiveKind: 'RECEIPT',
    });

    const restored = expectData(
      await api(app)
        .post(`/api/admin/trash/${trash.items[0]?.id ?? ''}/restore`)
        .set('Cookie', cookie),
      restoreTrashResponseSchema,
    );
    expect(restored.kind).toBe('RECEIPT');
    expect(restored.documentId).not.toBe(uploaded.receipt.id);
    expect(
      await api(app).get(`/api/receipts/${restored.documentId}`).set('Cookie', cookie),
    ).toHaveProperty('status', 200);
  });
});
