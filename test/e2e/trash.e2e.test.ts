import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  documentDetailDtoSchema,
  uploadDocumentResponseSchema,
} from '../../src/shared/contracts/documents';
import {
  emptyTrashResponseSchema,
  listTrashResponseSchema,
  restoreTrashResponseSchema,
} from '../../src/shared/contracts/trash';
import { createInviteResponseSchema, okResponseSchema } from '../../src/shared/contracts/users';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

// The trash (docs/05 §5.7a, docs/07 §7.3): where a file goes when it stops being part of a document.
// Everything here is an admin's, and the two homes of bytes leave it by different doors.
describe('Trash (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  const libraryRoot = process.env.LIBRARY_ROOT ?? '/tmp/test-library';
  const folder = 'trash-e2e';

  beforeAll(async () => {
    await mkdir(join(libraryRoot, folder), { recursive: true });
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    app.files.clear();
    seq += 1;
    adminCookie = await onboard(`trashadmin${seq}@legere.local`);
  });

  afterAll(async () => {
    await rm(join(libraryRoot, folder), { recursive: true, force: true }).catch(() => undefined);
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
      inviteToken: token,
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return cookie;
  }

  // A document of one library file, lying on the volume the way a scan would have left it.
  async function givenLibraryDocument(
    name: string,
    body = PDF,
  ): Promise<{
    documentId: string;
    fileId: string;
    libraryId: string;
    path: string;
  }> {
    seq += 1;
    const rootPath = `${folder}/library-${seq}`;
    await mkdir(join(libraryRoot, rootPath), { recursive: true });
    await writeFile(join(libraryRoot, rootPath, name), body);

    const library = await testPrisma().library.create({
      data: {
        name: `Trash ${seq}`,
        rootPath,
        visibility: 'ALL_USERS',
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    const document = await testPrisma().document.create({
      data: {
        title: `Scan ${seq}`,
        canonicalStatus: 'DONE',
        previewStatus: 'DONE',
        markdownStatus: 'DONE',
        analysisStatus: 'DONE',
        vectorizationStatus: 'SKIPPED',
      },
    });
    const file = await testPrisma().file.create({
      data: {
        contentHash: sha256(body),
        origin: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: BigInt(body.byteLength),
        name,
      },
    });
    await testPrisma().documentPage.create({
      data: { documentId: document.id, position: 0, fileId: file.id, pageIndex: null },
    });
    await testPrisma().fileRef.create({
      data: {
        libraryId: library.id,
        fileId: file.id,
        path: name,
        size: BigInt(body.byteLength),
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: sha256(body),
      },
    });

    return { documentId: document.id, fileId: file.id, libraryId: library.id, path: name };
  }

  // A document of our own bytes: an upload, with its object in the bucket.
  async function givenUploadedDocument(
    name: string,
    body: Buffer,
  ): Promise<{
    documentId: string;
    fileId: string;
  }> {
    const res = await api(app)
      .postBinary('/api/documents', body)
      .set('Cookie', adminCookie)
      .set('X-Legere-Filename', encodeURIComponent(name));
    const documentId = expectData(res, uploadDocumentResponseSchema).document.id;
    const detail = expectData(
      await api(app).get(`/api/documents/${documentId}`).set('Cookie', adminCookie),
      documentDetailDtoSchema,
    );
    return { documentId, fileId: detail.files[0]?.id ?? '' };
  }

  const listTrash = () =>
    api(app)
      .get('/api/admin/trash')
      .set('Cookie', adminCookie)
      .then((res) => expectData(res, listTrashResponseSchema));

  it('holds what a deleted document was made of, and says where each item came from', async () => {
    const { documentId, fileId } = await givenLibraryDocument('deleted.pdf');

    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

    const trash = await listTrash();
    expect(trash.total.items).toBe(1);
    expect(trash.items[0]).toMatchObject({
      id: fileId,
      name: 'deleted.pdf',
      origin: 'LIBRARY',
      reason: 'DOCUMENT_DELETED',
      // 🔒 No sweep will ever delete it: its bytes are on a read-only volume (ADR-007).
      purgeAfter: null,
    });
    // The title is the only thing left that says what these bytes were part of.
    expect(trash.items[0]?.trashedFrom).toMatch(/^Scan /);
    // And it names the path, which is how the person who owns the volume can clear it themselves.
    expect(trash.items[0]?.refs.map((ref) => ref.path)).toEqual(['deleted.pdf']);
  });

  it('dates an upload for the sweep, because that one is ours to delete', async () => {
    const { documentId } = await givenUploadedDocument('mine.pdf', PDF);

    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

    const trash = await listTrash();
    expect(trash.items[0]?.origin).toBe('MANAGED');
    // 30 days by default (docs/12 §12.4) — a date, not a countdown.
    expect(trash.items[0]?.purgeAfter).not.toBeNull();
  });

  it('hands the bytes back without restoring anything', async () => {
    const { documentId } = await givenLibraryDocument('readable.pdf');
    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);
    const trash = await listTrash();

    const res = await api(app)
      .get(`/api/admin/trash/${trash.items[0]?.id}/content`)
      .set('Cookie', adminCookie);

    // Streamed off the volume, even though the ref is EXCLUDED: excluded means "not ingested
    // again", never "the bytes went away" (docs/05 §5.7a).
    expect(res.status).toBe(200);
    const body: unknown = res.body;
    expect(Buffer.isBuffer(body) ? body : Buffer.from(String(res.text))).toEqual(PDF);
  });

  it('restores an item as a new document, and never into the one it left', async () => {
    const { documentId, fileId } = await givenLibraryDocument('wanted-back.pdf');
    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

    const res = await api(app)
      .post(`/api/admin/trash/${fileId}/restore`, {})
      .set('Cookie', adminCookie);

    expect(res.status).toBe(201);
    const { documentId: restoredId } = expectData(res, restoreTrashResponseSchema);
    expect(restoredId).not.toBe(documentId);

    const restored = expectData(
      await api(app).get(`/api/documents/${restoredId}`).set('Cookie', adminCookie),
      documentDetailDtoSchema,
    );
    // Titled after the file and holding exactly it, like a split (docs/05 §5.6).
    expect(restored.title).toBe('wanted-back');
    expect(restored.files.map((file) => file.id)).toEqual([fileId]);

    // 🔒 Its paths are live again: the bytes are on the volume and their hash is known, so the
    // exclusion that kept the scan off them has nothing left to hold back (docs/03 §3.3.9).
    const refs = await testPrisma().fileRef.findMany({ where: { fileId } });
    expect(refs.map((ref) => ref.status)).toEqual(['HASHED']);
    expect((await listTrash()).total.items).toBe(0);
  });

  it('deletes one item for good, and leaves the volume alone', async () => {
    const { documentId, fileId, libraryId } = await givenLibraryDocument('gone-for-good.pdf');
    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

    const res = await api(app).delete(`/api/admin/trash/${fileId}`).set('Cookie', adminCookie);

    expect(expectData(res, okResponseSchema)).toEqual({ ok: true });
    expect(await testPrisma().file.findUnique({ where: { id: fileId } })).toBeNull();
    // 🔒 The ref survives the file and stays EXCLUDED: the original is still on the volume, and this
    // is what stops the next scan ingesting it into a brand-new document (docs/03 §3.3.9).
    const refs = await testPrisma().fileRef.findMany({ where: { libraryId } });
    expect(refs.map((ref) => ref.status)).toEqual(['EXCLUDED']);
    expect(refs.map((ref) => ref.fileId)).toEqual([null]);
  });

  it('empties the whole trash, bytes of ours included', async () => {
    const uploaded = await givenUploadedDocument('ours.pdf', PDF);
    const onVolume = await givenLibraryDocument('theirs.pdf', Buffer.from('a different scan'));
    for (const documentId of [uploaded.documentId, onVolume.documentId]) {
      await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);
    }
    const key = artifactKeys.fileOriginal(uploaded.fileId, 'pdf');
    expect(app.files.keys()).toContain(key);

    const res = await api(app).delete('/api/admin/trash').set('Cookie', adminCookie);

    expect(expectData(res, emptyTrashResponseSchema)).toEqual({ deleted: 2 });
    expect((await listTrash()).total).toEqual({ items: 0, bytes: '0' });
    // Ours is gone from the bucket; theirs never had an object to delete.
    expect(app.files.keys()).not.toContain(key);
  });

  it('takes the pictures of a file’s pages with the file, whatever storage the file was in', async () => {
    const ours = await givenUploadedDocument('ours.pdf', PDF);
    const theirs = await givenLibraryDocument('theirs.pdf', Buffer.from('a scan on a volume'));
    // A page thumbnail is ours whichever storage the file's own bytes are in (docs/09 §9.2): a
    // library original has no object here and its rendered pages do.
    const pages = [
      artifactKeys.filePageThumb(ours.fileId, 0),
      artifactKeys.filePageThumb(theirs.fileId, 0),
    ];
    for (const key of pages) await app.files.put(key, Buffer.from('a page'), 'image/jpeg');
    for (const documentId of [ours.documentId, theirs.documentId]) {
      await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);
    }

    await api(app).delete('/api/admin/trash').set('Cookie', adminCookie);

    // The pages of a file that no longer exists are pictures of nothing anybody can ask for again.
    for (const key of pages) expect(app.files.keys()).not.toContain(key);
    expect(app.files.keys()).not.toContain(artifactKeys.fileOriginal(ours.fileId, 'pdf'));
  });

  it('is an admin’s, all of it', async () => {
    const cookie = await inviteUser(`trashreader${seq}@legere.local`);
    const { documentId, fileId } = await givenLibraryDocument('not-yours.pdf');
    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

    for (const res of [
      await api(app).get('/api/admin/trash').set('Cookie', cookie),
      await api(app).delete(`/api/admin/trash/${fileId}`).set('Cookie', cookie),
      await api(app).delete('/api/admin/trash').set('Cookie', cookie),
      await api(app).post(`/api/admin/trash/${fileId}/restore`, {}).set('Cookie', cookie),
      await api(app).get(`/api/admin/trash/${fileId}/content`).set('Cookie', cookie),
    ]) {
      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
    }
  });

  it('404s an id that is not in the trash', async () => {
    const { fileId } = await givenLibraryDocument('still-held.pdf');

    // The file exists — it is simply part of a document, which is the other place a file can be.
    const res = await api(app).delete(`/api/admin/trash/${fileId}`).set('Cookie', adminCookie);

    expect(res.status).toBe(404);
    expect(expectError(res).code).toBe('FILE_NOT_FOUND');
  });
});
