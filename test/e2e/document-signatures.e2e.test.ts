import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  documentSignaturesSchema,
  fileSignatureDtoSchema,
  MAX_SIGNATURES_PER_FILE,
} from '../../src/shared/contracts/signatures';
import { createApiTokenResponseSchema } from '../../src/shared/contracts/users';
import { PrismaFileSignatureRepository } from '../../src/server/infrastructure/persistence/prisma-file-signature.repository';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { FileSignatureRepository } from '../../src/server/domain/repositories/file-signature.repository';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import { expectData } from '../helpers/http';
import { onboardIdentity } from '../helpers/identity';
import { signatureFixture, signedPdf } from '../helpers/signatures';

describe('Electronic signatures (HTTP and persistence)', () => {
  let app: TestApp;
  let admin: string;
  let owner: string;
  let fixture: Awaited<ReturnType<typeof signatureFixture>>;
  let original: Buffer;
  let identitySequence = 0;
  beforeAll(async () => {
    fixture = await signatureFixture();
    const pdf = await PDFDocument.create();
    pdf.addPage();
    original = Buffer.from(await pdf.save());
    app = await createTestApp({ uploadMaxBytes: 16_384 });
  });
  beforeEach(async () => {
    await truncateAll();
    app.files.clear();
    admin = await onboardIdentity(app, `signatures-${++identitySequence}@example.test`);
    owner = (await testPrisma().user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id;
  });
  afterAll(async () => {
    await app?.close();
    await disconnectTestPrisma();
  });

  async function given(bytes = original, createdById = owner) {
    const doc = await seedDocument({
      document: { createdById },
      files: [
        {
          contentHash: createHash('sha256').update(bytes).digest('hex'),
          name: 'original.pdf',
          sizeBytes: BigInt(bytes.length),
        },
      ],
    });
    const fileId = doc.fileIds[0];
    if (fileId === undefined) throw new Error('No fixture file');
    const file = await testPrisma().file.findUniqueOrThrow({ where: { id: fileId } });
    if (file.storageKey === null) throw new Error('No fixture key');
    await app.files.put(file.storageKey, bytes, 'application/pdf');
    return {
      id: doc.id,
      fileId,
      root: `/api/documents/${doc.id}`,
      path: `/api/documents/${doc.id}/files/${fileId}/signatures`,
    };
  }
  const attach = async (path: string, signature: Buffer, cookie = admin) =>
    api(app)
      .postBinary(path, signature)
      .set('Cookie', cookie)
      .set('X-Legere-Filename', encodeURIComponent('Original.pdf.sig'));

  it('attaches exact bytes to an original, returns certificate details and authorizes attachment downloads', async () => {
    const doc = await given();
    const signature = await fixture.sign(original);
    const uploaded = await attach(doc.path, signature);
    expect(uploaded.status).toBe(201);
    const saved = expectData(uploaded, fileSignatureDtoSchema);
    expect(saved.report.signers[0]?.verification).toBe('VALID');
    const row = await testPrisma().fileSignature.findFirstOrThrow();
    expect(app.files.get(row.storageKey).body).toEqual(signature);
    const listing = expectData(
      await api(app).get(`${doc.root}/signatures`).set('Cookie', admin).expect(200),
      documentSignaturesSchema,
    );
    expect(listing.files[0]).toMatchObject({
      fileId: doc.fileId,
      discovery: 'COMPLETE',
      signatures: [{ id: saved.id }],
    });
    const download = await api(app)
      .get(`${doc.path}/${saved.id}/content`)
      .set('Cookie', admin)
      .expect(302);
    expect(download.headers.location).toContain(row.storageKey);
    expect(
      new URL(String(download.headers.location)).searchParams.get('response-content-disposition'),
    ).toContain('attachment;');
    await api(app).get(`${doc.path}/${saved.id}/content`).expect(401);
    await api(app).delete(`${doc.path}/${saved.id}`).set('Cookie', admin).expect(200);
    expect(await testPrisma().fileSignature.count()).toBe(0);
    expect(await app.files.exists(row.storageKey)).toBe(false);
  });
  it('refuses mismatches and malformed input before storing any attachment', async () => {
    const doc = await given();
    expect(
      (await attach(doc.path, await fixture.sign(Buffer.from('another original')))).status,
    ).toBe(422);
    expect((await attach(doc.path, Buffer.from('not CMS'))).status).toBe(422);
    expect(await testPrisma().fileSignature.count()).toBe(0);
    expect(app.files.keys().filter((key) => key.includes('/signatures/'))).toEqual([]);
  });
  it('bounds upload bodies and cleans up a stored object if its database write fails', async () => {
    const doc = await given();
    expect((await attach(doc.path, Buffer.alloc(app.uploadMaxBytes + 1))).status).toBe(413);
    const failure = vi
      .spyOn(app.nestApp.get(FileSignatureRepository), 'add')
      .mockRejectedValueOnce(new Error('Synthetic persistence outage'));
    try {
      expect((await attach(doc.path, await fixture.sign(original))).status).toBe(500);
      expect(app.files.keys().filter((key) => key.includes('/signatures/'))).toEqual([]);
      expect(await testPrisma().fileSignature.count()).toBe(0);
    } finally {
      failure.mockRestore();
    }
  });
  it('makes concurrent duplicate attachments idempotent and cleans surplus objects', async () => {
    const doc = await given();
    const signature = await fixture.sign(original);
    const uploads = await Promise.all([attach(doc.path, signature), attach(doc.path, signature)]);
    expect(uploads.map((res) => expectData(res, fileSignatureDtoSchema).id)[0]).toBe(
      expectData(uploads[1], fileSignatureDtoSchema).id,
    );
    expect(await testPrisma().fileSignature.count()).toBe(1);
    expect(app.files.keys().filter((key) => key.includes('/signatures/'))).toHaveLength(1);
  });
  it('does not disclose a private original to other users or accept unrelated file IDs', async () => {
    const doc = await given();
    const other = await onboardIdentity(app, 'reader@example.test', admin);
    await api(app).get(`${doc.root}/signatures`).set('Cookie', other).expect(404);
    expect((await attach(doc.path, await fixture.sign(original), other)).status).toBe(404);
    expect(
      (await attach(`${doc.root}/files/${randomUUID()}/signatures`, await fixture.sign(original)))
        .status,
    ).toBe(404);
  });
  it('shared readers cannot attach signatures, and read-only tokens cannot upload or delete', async () => {
    const other = await onboardIdentity(app, 'owner@example.test', admin);
    const otherId = (
      await testPrisma().user.findFirstOrThrow({ where: { email: 'owner@example.test' } })
    ).id;
    const doc = await given(original, otherId);
    const third = await onboardIdentity(app, 'shared@example.test', admin);
    const thirdId = (
      await testPrisma().user.findFirstOrThrow({ where: { email: 'shared@example.test' } })
    ).id;
    const collection = await testPrisma().collection.create({
      data: { name: 'Shared', ownerId: otherId },
    });
    await testPrisma().collectionItem.create({
      data: { collectionId: collection.id, documentId: doc.id, addedById: otherId },
    });
    await testPrisma().collectionShare.create({
      data: { collectionId: collection.id, granteeUserId: thirdId },
    });
    await api(app).get(`${doc.root}/signatures`).set('Cookie', third).expect(200);
    expect((await attach(doc.path, await fixture.sign(original), third)).status).toBe(403);
    const uploaded = expectData(
      await attach(doc.path, await fixture.sign(original), other),
      fileSignatureDtoSchema,
    );
    await api(app).delete(`${doc.path}/${uploaded.id}`).set('Cookie', third).expect(403);
    const token = expectData(
      await api(app)
        .post('/api/me/api-tokens', { name: 'Reader', scope: 'READ' })
        .set('Cookie', admin)
        .expect(201),
      createApiTokenResponseSchema,
    ).token;
    await api(app)
      .postBinary(doc.path, await fixture.sign(original))
      .set('Authorization', `Bearer ${token}`)
      .set('X-Legere-Filename', 'test.sig')
      .expect(403);
    await api(app)
      .delete(`${doc.path}/${uploaded.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });
  it('discovers embedded signatures in existing uploads without changing the original', async () => {
    const pdf = await signedPdf(fixture.sign);
    const doc = await given(pdf);
    const listing = expectData(
      await api(app).get(`${doc.root}/signatures`).set('Cookie', admin).expect(200),
      documentSignaturesSchema,
    );
    expect(listing.files[0]?.signatures[0]).toMatchObject({
      source: 'EMBEDDED',
      report: { coversWholeFile: true, signers: [{ verification: 'VALID' }] },
    });
    expect(await testPrisma().fileSignature.count()).toBe(0);
  });
  it('never transfers a signature to a replacement file', async () => {
    const doc = await given();
    const uploaded = expectData(
      await attach(doc.path, await fixture.sign(original)),
      fileSignatureDtoSchema,
    );
    const next = await testPrisma().file.create({
      data: {
        contentHash: 'f'.repeat(64),
        name: 'replacement.pdf',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 1n,
        origin: 'MANAGED',
      },
    });
    await testPrisma().documentPage.updateMany({
      where: { documentId: doc.id },
      data: { fileId: next.id },
    });
    const listing = expectData(
      await api(app).get(`${doc.root}/signatures`).set('Cookie', admin).expect(200),
      documentSignaturesSchema,
    );
    expect(listing.files[0]?.signatures).toEqual([]);
    await api(app).get(`${doc.path}/${uploaded.id}/content`).set('Cookie', admin).expect(404);
    expect(await testPrisma().fileSignature.count()).toBe(1);
  });
  it('enforces the per-original limit and cascades records when an original is purged', async () => {
    const doc = await given();
    const uploaded = expectData(
      await attach(doc.path, await fixture.sign(original)),
      fileSignatureDtoSchema,
    );
    const row = await testPrisma().fileSignature.findFirstOrThrow();
    await testPrisma().fileSignature.createMany({
      data: Array.from({ length: MAX_SIGNATURES_PER_FILE - 1 }, (_, i) => ({
        ...row,
        report: uploaded.report,
        id: randomUUID(),
        contentHash: String(i).padStart(64, '0'),
      })),
    });
    const repository = new PrismaFileSignatureRepository(app.nestApp.get(PrismaService));
    await expect(
      repository.add({
        ...row,
        report: uploaded.report,
        id: randomUUID(),
        contentHash: 'e'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await testPrisma().documentPage.deleteMany({ where: { fileId: doc.fileId } });
    await testPrisma().file.delete({ where: { id: doc.fileId } });
    expect(await testPrisma().fileSignature.count()).toBe(0);
  });
});
