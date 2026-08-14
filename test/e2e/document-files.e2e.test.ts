import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  documentDetailDtoSchema,
  documentMarkdownResponseSchema,
  uploadDocumentResponseSchema,
} from '../../src/shared/contracts/documents';
import {
  cropSuggestionResponseSchema,
  groupingSuggestionsResponseSchema,
  splitDocumentFileResponseSchema,
} from '../../src/shared/contracts/files';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const FILE_BODY = 'the bytes of the original file';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');

// A streamed binary body arrives as a Buffer rather than in `res.text`.
function bodyOf(res: { body: unknown; text?: string }): string {
  if (Buffer.isBuffer(res.body)) return res.body.toString();
  return res.text ?? '';
}

function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

// What the bucket has been told to answer with. The overrides ride on the presigned URL (docs/09
// §9.2), so the terms a browser will be served on are readable from the Location the API sends it to
// — including in this suite, where the storage is the in-memory double.
function deliveryOf(location: string | undefined): { contentType: string; disposition: string } {
  const query = new URL(location ?? '', 'http://redirect.test').searchParams;
  return {
    contentType: query.get('response-content-type') ?? '',
    disposition: query.get('response-content-disposition') ?? '',
  };
}

// The files a document is made of (docs/05 §5.6, docs/07 §7.3): composing them, and reading them
// back — the assembled PDF, or one original at a time.
describe('Document files (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  const libraryRoot = process.env.LIBRARY_ROOT ?? '/tmp/test-library';
  const folder = 'files-e2e';

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
    adminCookie = await onboard(`fileadmin${seq}@legere.local`);
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

  async function inviteUser(email: string): Promise<{ id: string; cookie: string }> {
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
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return { id: expectData(completed, userDtoSchema).id, cookie };
  }

  let contentSeq = 0;

  type FileSpec = {
    name?: string;
    body?: Buffer | string;
    mimeType?: string;
    ext?: string;
    mtime?: Date;
    // Written to the volume unless a test wants a ref pointing at nothing.
    onDisk?: boolean;
  };

  type LibraryFixture = { id: string; rootPath: string };

  type Fixture = {
    documentId: string;
    libraryId: string;
    rootPath: string;
    fileIds: string[];
    fileNames: string[];
  };

  // Each library gets a root of its own: two libraries may not point at one path, and a test that
  // needs two of them needs two folders.
  async function givenLibrary(
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<LibraryFixture> {
    contentSeq += 1;
    const rootPath = `${folder}/library-${contentSeq}`;
    await mkdir(join(libraryRoot, rootPath), { recursive: true });
    const library = await testPrisma().library.create({
      data: {
        name: `Files ${contentSeq}`,
        rootPath,
        visibility,
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    return { id: library.id, rootPath };
  }

  // A library document backed by real files on the volume, the way a scan would have left it.
  async function givenLibraryDocument(
    overrides: {
      title?: string;
      library?: LibraryFixture;
      visibility?: 'ALL_USERS' | 'RESTRICTED';
      canonicalStatus?: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
      previewStatus?: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
      titleSource?: 'NONE' | 'AUTO' | 'MANUAL';
      markdown?: string | null;
      files?: FileSpec[];
    } = {},
  ): Promise<Fixture> {
    const library = overrides.library ?? (await givenLibrary(overrides.visibility));
    const document = await testPrisma().document.create({
      data: {
        title: overrides.title ?? `Document ${(contentSeq += 1)}`,
        markdown: overrides.markdown ?? null,
        titleSource: overrides.titleSource ?? 'NONE',
        canonicalStatus: overrides.canonicalStatus ?? 'DONE',
        previewStatus: overrides.previewStatus ?? 'DONE',
        markdownStatus: 'DONE',
        analysisStatus: 'DONE',
        vectorizationStatus: 'SKIPPED',
      },
    });

    const specs = overrides.files ?? [{}];
    const fileIds: string[] = [];
    const fileNames: string[] = [];

    for (const [position, spec] of specs.entries()) {
      contentSeq += 1;
      const name = spec.name ?? `file-${contentSeq}.pdf`;
      const body = spec.body ?? `${FILE_BODY} ${contentSeq}`;
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);

      if (spec.onDisk !== false) {
        await writeFile(join(libraryRoot, library.rootPath, name), buffer);
      }

      const file = await testPrisma().file.create({
        data: {
          contentHash: sha256(buffer),
          origin: 'LIBRARY',
          mimeType: spec.mimeType ?? 'application/pdf',
          ext: spec.ext ?? name.split('.').pop() ?? 'pdf',
          sizeBytes: BigInt(buffer.byteLength),
          name,
        },
      });
      await testPrisma().documentFile.create({
        data: { documentId: document.id, position, fileId: file.id },
      });
      await testPrisma().fileRef.create({
        data: {
          libraryId: library.id,
          fileId: file.id,
          path: `${name}`,
          size: BigInt(buffer.byteLength),
          mtime: spec.mtime ?? new Date('2026-01-01T00:00:00.000Z'),
          status: 'HASHED',
          contentHash: sha256(buffer),
        },
      });

      fileIds.push(file.id);
      fileNames.push(name);
    }

    return {
      documentId: document.id,
      libraryId: library.id,
      rootPath: library.rootPath,
      fileIds,
      fileNames,
    };
  }

  // A document made of bytes of our own: an upload, or something we produced (docs/09 §9.2).
  async function givenManagedDocument(
    ownerId: string,
    body: Buffer = PDF,
  ): Promise<{ documentId: string; fileId: string; key: string }> {
    contentSeq += 1;
    const document = await testPrisma().document.create({
      data: {
        title: `Uploaded ${contentSeq}`,
        createdById: ownerId,
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
        origin: 'MANAGED',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: BigInt(body.byteLength),
        name: `uploaded-${contentSeq}.pdf`,
      },
    });
    const key = artifactKeys.fileOriginal(file.id, 'pdf');
    await testPrisma().file.update({ where: { id: file.id }, data: { storageKey: key } });
    await testPrisma().documentFile.create({
      data: { documentId: document.id, position: 0, fileId: file.id },
    });
    await app.files.put(key, body, 'application/pdf');

    return { documentId: document.id, fileId: file.id, key };
  }

  const detailOf = async (documentId: string, cookie = adminCookie) =>
    expectData(
      await api(app).get(`/api/documents/${documentId}`).set('Cookie', cookie),
      documentDetailDtoSchema,
    );

  const processJobs = (documentId: string): Promise<Array<{ data: { documentId: string } }>> =>
    testPrisma().$queryRawUnsafe(
      `SELECT data FROM pgboss.job WHERE name = 'document-process' AND data->>'documentId' = '${documentId}'`,
    );

  const addFile = (documentId: string, body: Buffer, fileName: string, cookie = adminCookie) =>
    api(app)
      .postBinary(`/api/documents/${documentId}/files`, body)
      .set('Cookie', cookie)
      .set('X-File-Name', encodeURIComponent(fileName));

  const uploadDocument = (body: Buffer, fileName: string, cookie = adminCookie) =>
    api(app)
      .postBinary('/api/documents', body)
      .set('Cookie', cookie)
      .set('X-Legere-Filename', encodeURIComponent(fileName));

  describe('adding a file', () => {
    it('appends the upload, stores its bytes and rebuilds the document', async () => {
      const { documentId, fileIds } = await givenLibraryDocument();

      const res = await addFile(documentId, PDF, 'page two.pdf');

      expect(res.status).toBe(201);
      const detail = expectData(res, documentDetailDtoSchema);
      // The whole document comes back: a composition change is never local (docs/07 §7.3).
      expect(detail.files.map((file) => file.position)).toEqual([0, 1]);
      expect(detail.files[0]?.id).toBe(fileIds[0]);
      expect(detail.files[1]).toMatchObject({
        name: 'page two.pdf',
        origin: 'MANAGED',
        available: true,
        refs: [],
      });
      expect(detail.fileCount).toBe(2);
      // One library file among two still makes the document a library document (docs/03 §3.3.10).
      expect(detail.origin).toBe('LIBRARY');

      const stored = await testPrisma().file.findFirstOrThrow({
        where: { contentHash: sha256(PDF) },
      });
      expect(app.files.get(artifactKeys.fileOriginal(stored.id, 'pdf')).body).toEqual(PDF);
      expect(await processJobs(documentId)).toHaveLength(1);

      const events = await testPrisma().documentEvent.findMany({ where: { documentId } });
      expect(events.map((event) => event.type)).toContain('FILE_ATTACHED');
      expect(events.map((event) => event.type)).toContain('QUEUED');
    });

    it('refuses bytes that already belong to another document', async () => {
      const first = await givenLibraryDocument({ files: [{ name: 'taken.pdf', body: 'mine' }] });
      const second = await givenLibraryDocument();

      // A text name, so the format gate (docs/05 §5.1a) lets the bytes through to the ownership
      // check this test is about: content decides, and 'mine' under a .pdf name is no format at all.
      const res = await addFile(second.documentId, Buffer.from('mine'), 'copy.txt');

      // A file has exactly one home; moving it is Combine, not a second upload (docs/05 §5.6).
      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('FILE_ALREADY_IN_DOCUMENT');
      expect((await detailOf(second.documentId)).files).toHaveLength(1);
      expect((await detailOf(first.documentId)).files).toHaveLength(1);
    });

    it('takes the file whatever Content-Type the client puts on it (🔒)', async () => {
      const { documentId } = await givenLibraryDocument();

      // 🔒 The body is the file, so no parser may touch this route either — and until the raw-body
      // routes were declared in one place, only `POST /api/documents` was exempt. A parser reading
      // this drains the stream and the handler answers "the uploaded file is empty"; over 1 MiB it
      // answers body-parser's own 500 (docs/05 §5.1a).
      const res = await api(app)
        .post(`/api/documents/${documentId}/files`)
        .set('Cookie', adminCookie)
        .set('X-File-Name', 'attached.txt')
        .type('application/json')
        .send('{"not":"a document, just bytes"}');

      expect(res.status).toBe(201);
      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail.files).toHaveLength(2);
      expect(detail.files[1]).toMatchObject({ name: 'attached.txt', origin: 'MANAGED' });
      expect(Number(detail.files[1]?.sizeBytes)).toBeGreaterThan(0);
    });

    it('refuses a body with no name at all', async () => {
      const { documentId } = await givenLibraryDocument();

      const res = await api(app)
        .postBinary(`/api/documents/${documentId}/files`, PDF)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(422);
      expect(expectError(res).code).toBe('VALIDATION_FAILED');
    });
  });

  // 🔒 The header every upload from the browser carries (docs/07 §7.3). This route read only the
  // other spelling, so attaching a file from the UI answered 422 — a request no page could make.
  it('takes the file name in the header the browser sends', async () => {
    const { documentId } = await givenLibraryDocument();

    const res = await api(app)
      .postBinary(`/api/documents/${documentId}/files`, PDF)
      .set('Cookie', adminCookie)
      .set('X-Legere-Filename', encodeURIComponent('from the browser.pdf'));

    expect(res.status).toBe(201);
    const detail = expectData(res, documentDetailDtoSchema);
    expect(detail.files.map((file) => file.name)).toContain('from the browser.pdf');
  });

  describe('reordering', () => {
    it('rewrites the order the client sends and rebuilds', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({
        files: [{ name: 'a.pdf' }, { name: 'b.pdf' }, { name: 'c.pdf' }],
      });
      const reversed = [...fileIds].reverse();

      const res = await api(app)
        .patch(`/api/documents/${documentId}/files`, { order: reversed })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      expect(expectData(res, documentDetailDtoSchema).files.map((file) => file.id)).toEqual(
        reversed,
      );
      expect(await processJobs(documentId)).toHaveLength(1);
    });

    it('refuses an order that is not the whole document', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({
        files: [{ name: 'x.pdf' }, { name: 'y.pdf' }],
      });

      const partial = await api(app)
        .patch(`/api/documents/${documentId}/files`, { order: [fileIds[0]] })
        .set('Cookie', adminCookie);

      expect(partial.status).toBe(422);
      expect(expectError(partial).code).toBe('VALIDATION_FAILED');
      // The pages are still where they were: a refused reorder changes nothing.
      expect((await detailOf(documentId)).files.map((file) => file.id)).toEqual(fileIds);
    });
  });

  describe('cropping', () => {
    const crop = {
      points: [
        [0.1, 0.1],
        [0.9, 0.12],
        [0.88, 0.9],
        [0.12, 0.88],
      ],
    };

    it('stores the quadrilateral a person dragged and rebuilds', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({
        files: [{ name: 'photo.jpg', mimeType: 'image/jpeg', ext: 'jpg' }],
      });
      const fileId = fileIds[0] ?? '';

      const res = await api(app)
        .patch(`/api/documents/${documentId}/files/${fileId}`, { crop })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const file = expectData(res, documentDetailDtoSchema).files[0];
      expect(file?.crop).toEqual(crop);
      // 🔒 MANUAL is what stops a rebuild from replacing it with what a detector found.
      expect(file?.cropSource).toBe('MANUAL');
      expect(await processJobs(documentId)).toHaveLength(1);

      const cleared = await api(app)
        .patch(`/api/documents/${documentId}/files/${fileId}`, { crop: null })
        .set('Cookie', adminCookie);
      expect(expectData(cleared, documentDetailDtoSchema).files[0]).toMatchObject({
        crop: null,
        cropSource: 'NONE',
      });
    });

    it('refuses to crop something that is not an image', async () => {
      const { documentId, fileIds } = await givenLibraryDocument();

      const res = await api(app)
        .patch(`/api/documents/${documentId}/files/${fileIds[0]}`, { crop })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(422);
      expect(expectError(res).code).toBe('FILE_NOT_IMAGE');
    });

    it('proposes corners for an image without storing them', async () => {
      const image = await sharp({
        create: { width: 200, height: 150, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      const { documentId, fileIds } = await givenLibraryDocument({
        files: [{ name: 'page.png', body: image, mimeType: 'image/png', ext: 'png' }],
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/files/${fileIds[0]}/crop-suggestion`)
        .set('Cookie', adminCookie);

      const suggestion = expectData(res, cropSuggestionResponseSchema);
      // A blank sheet holds no page to find, so the honest answer is the content box (docs/05 §5.6).
      expect(suggestion.method).toBe('CONTENT_BOX');
      expect(suggestion.crop.points).toHaveLength(4);
      // A proposal is not a change: nothing is stored until the client saves it.
      expect((await detailOf(documentId)).files[0]?.cropSource).toBe('NONE');
    });
  });

  describe('splitting', () => {
    it('gives the file a document of its own and leaves the rest behind', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({
        title: 'Two pages',
        files: [{ name: 'first.pdf' }, { name: 'second.pdf' }],
      });

      const res = await api(app)
        .delete(`/api/documents/${documentId}/files/${fileIds[1]}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const { document, splitDocumentId } = expectData(res, splitDocumentFileResponseSchema);
      expect(document.files.map((file) => file.id)).toEqual([fileIds[0]]);

      const split = await detailOf(splitDocumentId);
      // Titled after the file and inheriting nothing else (docs/05 §5.6).
      expect(split.title).toBe('second');
      expect(split.files.map((file) => file.id)).toEqual([fileIds[1]]);
      // Both documents are rebuilt: one lost a page and the other is new.
      expect(await processJobs(documentId)).toHaveLength(1);
      expect(await processJobs(splitDocumentId)).toHaveLength(1);
    });

    it('refuses to take the only file away', async () => {
      const { documentId, fileIds } = await givenLibraryDocument();

      const res = await api(app)
        .delete(`/api/documents/${documentId}/files/${fileIds[0]}`)
        .set('Cookie', adminCookie);

      // 🔒 A document is emptied by deleting it, not by taking its parts away (docs/03 §3.3.10).
      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('DOCUMENT_LAST_FILE');
      expect((await detailOf(documentId)).files).toHaveLength(1);
    });

    it('404s a file that belongs to another document', async () => {
      const mine = await givenLibraryDocument({
        files: [{ name: 'one.pdf' }, { name: 'two.pdf' }],
      });
      const other = await givenLibraryDocument();

      const res = await api(app)
        .delete(`/api/documents/${mine.documentId}/files/${other.fileIds[0]}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('FILE_NOT_FOUND');
    });
  });

  // A better copy of one page, in the place of the one that is there (docs/05 §5.6) — and the old
  // scan kept, because "this one is better" is a judgement people take back (docs/05 §5.7a).
  describe('replacing a file', () => {
    const replace = (documentId: string, fileId: string, body: Buffer, fileName: string) =>
      api(app)
        .postBinary(`/api/documents/${documentId}/files/${fileId}/replacement`, body)
        .set('Cookie', adminCookie)
        .set('X-Legere-Filename', encodeURIComponent(fileName));

    it('puts the new file in the old one’s place and the old one in the trash', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({
        title: 'Three pages',
        files: [{ name: 'first.pdf' }, { name: 'second.pdf' }, { name: 'third.pdf' }],
      });

      const res = await replace(documentId, `${fileIds[1]}`, PDF, 'second-again.pdf');

      expect(res.status).toBe(200);
      const detail = expectData(res, documentDetailDtoSchema);
      // 🔒 The position, which is the whole difference from add-then-reorder: page two is still
      // page two, and the pages either side of it did not move.
      expect(detail.files.map((file) => file.position)).toEqual([0, 1, 2]);
      expect(detail.files[0]?.id).toBe(fileIds[0]);
      expect(detail.files[2]?.id).toBe(fileIds[2]);
      expect(detail.files[1]?.name).toBe('second-again.pdf');
      expect(detail.files[1]?.id).not.toBe(fileIds[1]);

      // The old scan is not destroyed: it is in the trash, under the file that took its place, and
      // the document says so where somebody comparing the two will look.
      expect(detail.files[1]?.earlierVersions.map((version) => version.id)).toEqual([fileIds[1]]);
      const old = await testPrisma().file.findUniqueOrThrow({ where: { id: `${fileIds[1]}` } });
      expect(old.trashedReason).toBe('REPLACED');
      expect(old.trashedFrom).toBe('Three pages');
      expect(old.replacedById).toBe(detail.files[1]?.id);
      // And the pages changed, so the document is rebuilt.
      expect(await processJobs(documentId)).toHaveLength(1);
    });

    it('keeps every earlier copy under the file that is there now', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({ files: [{ name: 'page.pdf' }] });

      const first = expectData(
        await replace(documentId, `${fileIds[0]}`, PDF, 'take-2.pdf'),
        documentDetailDtoSchema,
      );
      const second = expectData(
        await replace(
          documentId,
          `${first.files[0]?.id}`,
          Buffer.from(`${PDF.toString()}% take three`),
          'take-3.pdf',
        ),
        documentDetailDtoSchema,
      );

      // Both earlier copies hang off the file in the document now — not off each other — so one
      // query answers "the versions of this page" however often it is replaced (docs/03 §3.3.16).
      const versions = second.files[0]?.earlierVersions ?? [];
      expect(versions.map((version) => version.name)).toEqual(['take-2.pdf', 'page.pdf']);
      expect(second.files[0]?.name).toBe('take-3.pdf');
    });

    it('refuses bytes that are already a file of another document', async () => {
      const library = await givenLibrary();
      const theirs = Buffer.from('the page of somebody else');
      const mine = await givenLibraryDocument({ library, files: [{ name: 'mine.pdf' }] });
      await givenLibraryDocument({
        library,
        files: [{ name: 'theirs.pdf', body: theirs }],
      });

      // A text name, so the format gate (docs/05 §5.1a) lets the bytes reach the ownership check.
      const res = await replace(mine.documentId, `${mine.fileIds[0]}`, theirs, 'stolen.txt');

      // 🔒 A file has exactly one home (docs/03 §3.3.16); moving one is Combine, not a replacement.
      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('FILE_ALREADY_IN_DOCUMENT');
    });

    it('takes an earlier version back out of the trash rather than refusing it', async () => {
      const original = Buffer.from('the first scan of this page');
      const { documentId, fileIds } = await givenLibraryDocument({
        files: [{ name: 'page.pdf', body: original }],
      });

      const replaced = expectData(
        await replace(documentId, `${fileIds[0]}`, PDF, 'better.pdf'),
        documentDetailDtoSchema,
      );
      // The same bytes are one file (ADR-021), and these are in the trash rather than in a
      // document — so sending them again is "the one I threw away was better", not a conflict.
      const back = expectData(
        // Under a text name, so the format gate (docs/05 §5.1a) reads these bytes as text/plain:
        // restoration matches by content hash, not by the name on the wire.
        await replace(documentId, `${replaced.files[0]?.id}`, original, 'page.txt'),
        documentDetailDtoSchema,
      );

      expect(back.files[0]?.id).toBe(fileIds[0]);
      const restored = await testPrisma().file.findUniqueOrThrow({
        where: { id: `${fileIds[0]}` },
      });
      expect(restored.trashedAt).toBeNull();
    });
  });

  describe('combining', () => {
    it('moves the files over in the order given and buries the emptied documents', async () => {
      const library = await givenLibrary();
      const target = await givenLibraryDocument({ library, files: [{ name: 'target.pdf' }] });
      const first = await givenLibraryDocument({ library, files: [{ name: 'extra-1.pdf' }] });
      const second = await givenLibraryDocument({ library, files: [{ name: 'extra-2.pdf' }] });

      const res = await api(app)
        .post(`/api/documents/${target.documentId}/combine`, {
          documentIds: [second.documentId, first.documentId],
        })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail.files.map((file) => file.id)).toEqual([
        target.fileIds[0],
        second.fileIds[0],
        first.fileIds[0],
      ]);

      // The emptied rows are gone, with their own titles and types (docs/05 §5.6).
      for (const absorbed of [first, second]) {
        const row = await testPrisma().document.findUniqueOrThrow({
          where: { id: absorbed.documentId },
        });
        expect(row.deletedAt).not.toBeNull();
        expect(
          (await api(app).get(`/api/documents/${absorbed.documentId}`).set('Cookie', adminCookie))
            .status,
        ).toBe(404);
      }
      expect(await processJobs(target.documentId)).toHaveLength(1);
    });

    it('refuses to combine a document into itself', async () => {
      const { documentId } = await givenLibraryDocument();

      const res = await api(app)
        .post(`/api/documents/${documentId}/combine`, { documentIds: [documentId] })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(422);
      expect(expectError(res).code).toBe('VALIDATION_FAILED');
    });

    it('refuses a document the caller cannot even see', async () => {
      const mine = await givenLibraryDocument({ visibility: 'ALL_USERS' });
      const hidden = await givenLibraryDocument({ visibility: 'RESTRICTED' });
      const user = await inviteUser(`combiner${seq}@legere.local`);

      const res = await api(app)
        .post(`/api/documents/${mine.documentId}/combine`, { documentIds: [hidden.documentId] })
        .set('Cookie', user.cookie);

      // 🔒 Not found, not forbidden: the existence of the other document is not confirmed.
      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('DOCUMENT_NOT_FOUND');
      expect((await detailOf(mine.documentId)).files).toHaveLength(1);
    });

    it('refuses a document the caller may read but not edit', async () => {
      const owner = await inviteUser(`owner${seq}@legere.local`);
      const reader = await inviteUser(`reader${seq}@legere.local`);
      const managed = await givenManagedDocument(owner.id);
      const target = await givenLibraryDocument();

      // Shared for reading, which is not the same as shared for editing (docs/08 §8.5).
      const collection = await testPrisma().collection.create({
        data: { ownerId: owner.id, name: `Shared ${seq}` },
      });
      await testPrisma().collectionItem.create({
        data: {
          collectionId: collection.id,
          documentId: managed.documentId,
          addedById: owner.id,
        },
      });
      await testPrisma().collectionShare.create({
        data: { collectionId: collection.id, granteeUserId: reader.id },
      });

      const res = await api(app)
        .post(`/api/documents/${target.documentId}/combine`, {
          documentIds: [managed.documentId],
        })
        .set('Cookie', reader.cookie);

      // 🔒 A document with no library file is its creator's; absorbing it would destroy it.
      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
      expect((await detailOf(target.documentId, reader.cookie)).files).toHaveLength(1);
    });
  });

  describe('downloading the document', () => {
    it('redirects to the canonical PDF for reading, and streams it for saving', async () => {
      const { documentId } = await givenLibraryDocument({ title: 'Rental agreement' });
      await app.files.put(artifactKeys.canonicalPdf(documentId), PDF, 'application/pdf');

      const inline = await api(app)
        .get(`/api/documents/${documentId}/canonical`)
        .set('Cookie', adminCookie)
        .redirects(0);
      expect(inline.status).toBe(302);
      expect(inline.headers.location).toContain(artifactKeys.canonicalPdf(documentId));
      // 🔒 Short-lived, never a permanent link (docs/08 §8.5).
      expect(inline.headers.location).toContain('X-Amz-Expires=300');

      const saved = await api(app)
        .get(`/api/documents/${documentId}/canonical?download=1`)
        .set('Cookie', adminCookie)
        .buffer(true);
      expect(saved.status).toBe(200);
      expect(saved.headers['content-type']).toContain('application/pdf');
      // The name a person ends up with is the title of the document (docs/11 §11.5b).
      expect(saved.headers['content-disposition']).toContain('attachment');
      expect(saved.headers['content-disposition']).toContain('filename="Rental agreement.pdf"');
      expect(bodyOf(saved)).toBe(PDF.toString());
    });

    it('says plainly that the PDF is still being assembled', async () => {
      const { documentId } = await givenLibraryDocument({ canonicalStatus: 'PENDING' });

      const res = await api(app)
        .get(`/api/documents/${documentId}/canonical`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('CANONICAL_NOT_READY');
    });

    it('has no /source route any more', async () => {
      const { documentId } = await givenLibraryDocument();

      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', adminCookie);

      // The originals are one level down, under /files/:fileId/content (docs/07 §7.3).
      expect(res.status).toBe(404);
    });

    it('encodes a non-ASCII title per RFC 5987 and still offers an ASCII fallback', async () => {
      const { documentId } = await givenLibraryDocument({ title: 'Счёт за январь' });
      await app.files.put(artifactKeys.canonicalPdf(documentId), PDF, 'application/pdf');

      const res = await api(app)
        .get(`/api/documents/${documentId}/canonical?download=1`)
        .set('Cookie', adminCookie);

      const disposition = res.headers['content-disposition'] ?? '';
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).toContain(encodeURIComponent('Счёт за январь.pdf'));
      // The plain parameter stays ASCII, or old clients mangle the whole header.
      const plain = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
      expect(/^[\x20-\x7e]*$/.test(plain)).toBe(true);
    });
  });

  describe('downloading one original', () => {
    it('streams a library file with its length, type and own name', async () => {
      const { documentId, fileIds, fileNames } = await givenLibraryDocument({
        files: [{ name: 'scan.pdf', body: FILE_BODY }],
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/files/${fileIds[0]}/content`)
        .set('Cookie', adminCookie)
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(FILE_BODY)));
      expect(res.headers['content-disposition']).toContain(`filename="${fileNames[0]}"`);
      // 🔒 User content served from our own origin must not be sniffed into something executable.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(bodyOf(res)).toBe(FILE_BODY);
    });

    it('redirects a managed file to a signed URL', async () => {
      const owner = await inviteUser(`uploader${seq}@legere.local`);
      const managed = await givenManagedDocument(owner.id);

      const res = await api(app)
        .get(`/api/documents/${managed.documentId}/files/${managed.fileId}/content`)
        .set('Cookie', owner.cookie)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(managed.key);
      // 🔒 The branch that used to return before anything was said about the bytes (SEC-03): it says
      // it on the redirect, and the same terms are signed into the URL the browser leaves for.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(deliveryOf(res.headers.location).contentType).toBe('application/pdf');
      expect(deliveryOf(res.headers.location).disposition).toContain('attachment');
    });

    it('marks the ref MISSING and answers DOCUMENT_UNAVAILABLE when the file has vanished', async () => {
      const fixture = await givenLibraryDocument();
      const { documentId, fileIds } = fixture;
      await rm(join(libraryRoot, fixture.rootPath, fixture.fileNames[0] ?? ''));

      const res = await api(app)
        .get(`/api/documents/${documentId}/files/${fileIds[0]}/content`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('DOCUMENT_UNAVAILABLE');
      // The next listing tells the truth instead of offering a download that fails again.
      const ref = await testPrisma().fileRef.findFirstOrThrow({
        where: { fileId: fileIds[0] ?? '' },
      });
      expect(ref.status).toBe('MISSING');
      expect(ref.missingSince).not.toBeNull();
    });

    it('answers DOCUMENT_UNAVAILABLE when every ref is already MISSING', async () => {
      const { documentId, fileIds } = await givenLibraryDocument();
      await testPrisma().fileRef.updateMany({
        where: { fileId: fileIds[0] ?? '' },
        data: { status: 'MISSING', missingSince: new Date() },
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/files/${fileIds[0]}/content`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('DOCUMENT_UNAVAILABLE');
      // The document itself still reads, and says its originals are elsewhere (docs/05 §5.7).
      expect((await detailOf(documentId)).availability).toBe('UNAVAILABLE');
    });
  });

  describe('derived artifacts', () => {
    it('redirects preview and thumb to signed URLs', async () => {
      const { documentId } = await givenLibraryDocument();

      const preview = await api(app)
        .get(`/api/documents/${documentId}/preview`)
        .set('Cookie', adminCookie)
        .redirects(0);
      const thumb = await api(app)
        .get(`/api/documents/${documentId}/thumb`)
        .set('Cookie', adminCookie)
        .redirects(0);

      expect(preview.status).toBe(302);
      expect(preview.headers.location).toContain(artifactKeys.preview(documentId));
      expect(thumb.headers.location).toContain(artifactKeys.thumbnail(documentId));
    });

    it('still lets the pictures and the PDF the page shows render where they stand', async () => {
      const { documentId } = await givenLibraryDocument();
      await app.files.put(artifactKeys.canonicalPdf(documentId), PDF, 'application/pdf');

      const [preview, thumb, canonical] = await Promise.all([
        api(app)
          .get(`/api/documents/${documentId}/preview`)
          .set('Cookie', adminCookie)
          .redirects(0),
        api(app).get(`/api/documents/${documentId}/thumb`).set('Cookie', adminCookie).redirects(0),
        api(app)
          .get(`/api/documents/${documentId}/canonical`)
          .set('Cookie', adminCookie)
          .redirects(0),
      ]);

      // What the grid's <img> and the viewer's <object> point at: their own type, rendered in place
      // (docs/11 §11.5b). Locking uploads down must not lock these down with them.
      expect(deliveryOf(preview.headers.location)).toEqual({
        contentType: 'image/jpeg',
        disposition: 'inline',
      });
      expect(deliveryOf(thumb.headers.location)).toEqual({
        contentType: 'image/jpeg',
        disposition: 'inline',
      });
      expect(deliveryOf(canonical.headers.location)).toEqual({
        contentType: 'application/pdf',
        disposition: 'inline',
      });
      // Present all the same, on the branch that used to say nothing at all (SEC-03).
      expect(preview.headers['x-content-type-options']).toBe('nosniff');
      expect(canonical.headers['x-content-type-options']).toBe('nosniff');
      expect(canonical.headers['content-disposition']).toBe('inline');
    });

    it('404s a preview the pipeline never produced', async () => {
      const { documentId } = await givenLibraryDocument({ previewStatus: 'SKIPPED' });

      const res = await api(app)
        .get(`/api/documents/${documentId}/preview`)
        .set('Cookie', adminCookie);

      // Better than a redirect to a URL that 404s from the bucket instead.
      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('NOT_FOUND');
    });
  });

  // 🔒 SEC-03. Below the magic-byte line the MIME of an upload is the uploader's own claim about
  // their file, so a document library accepts, stores and hands back things a browser would run if
  // it were told what they say they are. Nothing uploaded is served on terms a browser can act on.
  describe('nothing uploaded is served as a page', () => {
    const executable = [
      // The two the detector believes on the strength of the name alone (docs/06 §6.3.3) …
      { fileName: 'report.html', body: '<script>fetch("/api/admin/users")</script>' },
      { fileName: 'report.htm', body: '<html><body>a page</body></html>' },
      // … and an XML whose processing instruction can point at a second upload. An SVG — a document
      // with scripts in it wearing the name of a picture — no longer gets past the door at all: its
      // bytes detect as no format, and no format is refused at upload (docs/05 §5.1a).
      { fileName: 'feed.xml', body: '<?xml-stylesheet href="evil.xsl"?><feed>text</feed>' },
    ];

    for (const upload of executable) {
      it(`hands back an uploaded ${upload.fileName} as bytes to save, not as a page`, async () => {
        const created = await uploadDocument(Buffer.from(upload.body), upload.fileName);
        expect(created.status).toBe(201);
        const documentId = expectData(created, uploadDocumentResponseSchema).document.id;
        const file = (await detailOf(documentId)).files[0];

        const res = await api(app)
          .get(`/api/documents/${documentId}/files/${file?.id ?? ''}/content`)
          .set('Cookie', adminCookie)
          .redirects(0);

        expect(res.status).toBe(302);
        // What the bucket has been told to answer with, signed into the URL so it cannot be edited
        // out of it (docs/09 §9.2). Nothing here is a type a browser renders as a document.
        expect(deliveryOf(res.headers.location).contentType).toBe('application/octet-stream');
        expect(deliveryOf(res.headers.location).disposition).toContain('attachment');
        expect(deliveryOf(res.headers.location).disposition).toContain(upload.fileName);
        // And on the redirect itself, which said neither of these before.
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-disposition']).toContain('attachment');

        // Depth: the object was stored as something to save too, so a presign written without
        // thinking about any of this still cannot serve a page (docs/09 §9.2).
        const stored = await testPrisma().file.findFirstOrThrow({
          where: { contentHash: sha256(upload.body) },
        });
        expect(app.files.get(artifactKeys.fileOriginal(stored.id, stored.ext)).contentType).toBe(
          'application/octet-stream',
        );
      });
    }

    it('keeps the detected type on the row, so an HTML upload is still converted like one', async () => {
      const created = await uploadDocument(Buffer.from('<html>a page</html>'), 'page.html');
      const file = (await detailOf(expectData(created, uploadDocumentResponseSchema).document.id))
        .files[0];

      // The row is what the pipeline classifies from (docs/03 §3.3.10, docs/05 §5.5 step 1): serving
      // it as bytes to save must not turn an office format into an unsupported one.
      expect(file?.mimeType).toBe('text/html');
      expect(file?.ext).toBe('html');
    });

    it('lets an uploaded picture keep its own type, since the crop editor loads it into an <img>', async () => {
      const png = await sharp({
        create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
      })
        .png()
        .toBuffer();
      const created = await uploadDocument(png, 'passport.png');
      const documentId = expectData(created, uploadDocumentResponseSchema).document.id;
      const file = (await detailOf(documentId)).files[0];

      const res = await api(app)
        .get(`/api/documents/${documentId}/files/${file?.id ?? ''}/content`)
        .set('Cookie', adminCookie)
        .redirects(0);

      // On the allow-list, so it says what it is — and is still something to save rather than a page
      // to open, which an <img> does not care about (docs/09 §9.2).
      expect(deliveryOf(res.headers.location)).toMatchObject({ contentType: 'image/png' });
      expect(deliveryOf(res.headers.location).disposition).toContain('attachment');
    });

    it('serves a library file on the same terms, streamed rather than redirected', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({
        files: [{ name: 'page.html', body: '<html>from the volume</html>', mimeType: 'text/html' }],
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/files/${fileIds[0]}/content`)
        .set('Cookie', adminCookie)
        .buffer(true);

      // One rule for an original, whichever storage holds it: our own origin serves the same bytes
      // under the same two headers (docs/09 §9.1).
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(bodyOf(res)).toBe('<html>from the volume</html>');
    });
  });

  describe('markdown', () => {
    it('returns the extracted text, and null when there is none', async () => {
      const withText = await givenLibraryDocument({ markdown: '# Invoice\n\nAmount due' });
      const without = await givenLibraryDocument({ markdown: null });

      expect(
        expectData(
          await api(app)
            .get(`/api/documents/${withText.documentId}/markdown`)
            .set('Cookie', adminCookie),
          documentMarkdownResponseSchema,
        ).markdown,
      ).toBe('# Invoice\n\nAmount due');
      expect(
        expectData(
          await api(app)
            .get(`/api/documents/${without.documentId}/markdown`)
            .set('Cookie', adminCookie),
          documentMarkdownResponseSchema,
        ).markdown,
      ).toBeNull();
    });
  });

  describe('grouping suggestions', () => {
    const scannedAt = (minutes: number) => new Date(Date.UTC(2026, 6, 14, 11, minutes, 0));

    async function givenScan(
      library: LibraryFixture,
      name: string,
      minutes: number,
      overrides: { titleSource?: 'NONE' | 'AUTO' | 'MANUAL' } = {},
    ): Promise<string> {
      const fixture = await givenLibraryDocument({
        library,
        titleSource: overrides.titleSource ?? 'NONE',
        files: [
          {
            name,
            mimeType: 'image/jpeg',
            ext: 'jpg',
            body: `image bytes of ${name}`,
            mtime: scannedAt(minutes),
          },
        ],
      });
      return fixture.documentId;
    }

    it('offers a run of scans as one document', async () => {
      const library = await givenLibrary();
      const first = await givenScan(library, 'passport-01.jpg', 0);
      const second = await givenScan(library, 'passport-02.jpg', 1);
      const third = await givenScan(library, 'passport-03.jpg', 2);
      // Hours later and named differently: a different sitting, and no suggestion of its own.
      await givenScan(library, 'unrelated.jpg', 600);

      const res = await api(app)
        .get('/api/documents/grouping-suggestions')
        .set('Cookie', adminCookie);

      const { items } = expectData(res, groupingSuggestionsResponseSchema);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        documentIds: [first, second, third],
        libraryId: library.id,
        folder: '',
        reason: 'NAME_SEQUENCE',
      });
    });

    it('never suggests a document somebody has already titled', async () => {
      const library = await givenLibrary();
      await givenScan(library, 'deed-01.jpg', 0, { titleSource: 'MANUAL' });
      await givenScan(library, 'deed-02.jpg', 1);

      const res = await api(app)
        .get('/api/documents/grouping-suggestions')
        .set('Cookie', adminCookie);

      // A suggestion that undoes somebody's work is worse than no suggestion (docs/05 §5.6a).
      expect(expectData(res, groupingSuggestionsResponseSchema).items).toEqual([]);
    });

    it('shows nothing from a library the caller was not granted', async () => {
      const library = await givenLibrary('RESTRICTED');
      await givenScan(library, 'secret-01.jpg', 0);
      await givenScan(library, 'secret-02.jpg', 1);
      const outsider = await inviteUser(`stranger${seq}@legere.local`);

      const res = await api(app)
        .get('/api/documents/grouping-suggestions')
        .set('Cookie', outsider.cookie);

      expect(expectData(res, groupingSuggestionsResponseSchema).items).toEqual([]);
    });
  });

  describe('authorization', () => {
    it('refuses every file route exactly like the metadata routes', async () => {
      const { documentId, fileIds } = await givenLibraryDocument({ visibility: 'RESTRICTED' });
      const outsider = await inviteUser(`outsider${seq}@legere.local`);

      for (const path of [
        'preview',
        'thumb',
        'canonical',
        'markdown',
        `files/${fileIds[0]}/content`,
        `files/${fileIds[0]}/crop-suggestion`,
      ]) {
        const res = await api(app)
          .get(`/api/documents/${documentId}/${path}`)
          .set('Cookie', outsider.cookie);
        // 🔒 Same answer as the detail route: not even the existence of the document is confirmed.
        expect(res.status).toBe(404);
        expect(expectError(res).code).toBe('DOCUMENT_NOT_FOUND');

        const anonymous = await api(app).get(`/api/documents/${documentId}/${path}`);
        expect(anonymous.status).toBe(401);
      }
    });

    it('lets a granted user download and compose the same document', async () => {
      const { documentId, libraryId, fileIds } = await givenLibraryDocument({
        visibility: 'RESTRICTED',
        files: [{ name: 'granted.pdf', body: FILE_BODY }],
      });
      const user = await inviteUser(`granted${seq}@legere.local`);
      await testPrisma().libraryAccess.create({ data: { libraryId, userId: user.id } });

      const download = await api(app)
        .get(`/api/documents/${documentId}/files/${fileIds[0]}/content`)
        .set('Cookie', user.cookie)
        .buffer(true);
      expect(download.status).toBe(200);
      expect(bodyOf(download)).toBe(FILE_BODY);

      // Library content is shared property: whoever may read it may tidy it up (docs/03 §3.4).
      const added = await addFile(documentId, PDF, 'added by a reader.pdf', user.cookie);
      expect(added.status).toBe(201);
      expect(expectData(added, documentDetailDtoSchema).files).toHaveLength(2);
    });
  });
});
