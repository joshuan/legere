import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  documentDetailDtoSchema,
  documentLinksResponseSchema,
  uploadDocumentResponseSchema,
  type DocumentDetailDto,
} from '../../src/shared/contracts/documents';
import {
  moveDocumentPagesResponseSchema,
  splitDocumentResponseSchema,
} from '../../src/shared/contracts/files';
import { collectionDtoSchema } from '../../src/shared/contracts/collections';
import { listTrashResponseSchema } from '../../src/shared/contracts/trash';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, tokenFromFragmentUrl, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

// A real picture, because what a file is is decided from its content and not from its name
// (docs/03 §3.3.16). Each one differs, so two uploads are two files.
function pictureOf(width: number): Promise<Buffer> {
  return sharp({ create: { width, height: 8, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
}

// A document arranged by the page (docs/05 §5.6, docs/07 §7.3, ADR-025): a photograph put between
// page two and page three, a scan cut where the next contract begins, a page that belongs elsewhere
// sent there. 🔒 None of it copies a byte — what moves is the entry that says which page of which
// file stands where.
describe('Document pages (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  const libraryRoot = process.env.LIBRARY_ROOT ?? '/tmp/test-library';
  const folder = 'pages-e2e';

  beforeAll(async () => {
    await mkdir(join(libraryRoot, folder), { recursive: true });
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
    app.emails.reset();
    app.files.clear();
    seq += 1;
    adminCookie = await onboard(`pagesadmin${seq}@legere.local`);
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
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return { id: expectData(completed, userDtoSchema).id, cookie };
  }

  type SeedFile = { name?: string; body?: Buffer; mimeType?: string; pageCount?: number | null };

  // A document written straight to the database, the way a scan and a first build would have left
  // it: one row per file, and one `document_pages` row per page of every file whose pages a build
  // has counted (docs/03 §3.3.17).
  async function givenDocument(
    files: SeedFile[],
    options: { createdById?: string } = {},
  ): Promise<{ documentId: string; libraryId: string; fileIds: string[] }> {
    seq += 1;
    const rootPath = `${folder}/library-${seq}`;
    await mkdir(join(libraryRoot, rootPath), { recursive: true });
    const library = await testPrisma().library.create({
      data: {
        name: `Pages ${seq}`,
        rootPath,
        visibility: 'ALL_USERS',
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    const document = await testPrisma().document.create({
      data: {
        title: `Scan ${seq}`,
        ...(options.createdById === undefined ? {} : { createdById: options.createdById }),
        canonicalStatus: 'DONE',
        previewStatus: 'DONE',
        markdownStatus: 'DONE',
        analysisStatus: 'DONE',
        vectorizationStatus: 'SKIPPED',
      },
    });

    const fileIds: string[] = [];
    let position = 0;
    for (const spec of files) {
      seq += 1;
      const name = spec.name ?? `file-${seq}.pdf`;
      const body = spec.body ?? Buffer.concat([PDF, Buffer.from(`#${seq}`)]);
      await writeFile(join(libraryRoot, rootPath, name), body);

      const file = await testPrisma().file.create({
        data: {
          contentHash: sha256(body),
          origin: 'LIBRARY',
          mimeType: spec.mimeType ?? 'application/pdf',
          ext: name.split('.').pop() ?? 'pdf',
          sizeBytes: BigInt(body.byteLength),
          name,
          pageCount: spec.pageCount ?? null,
        },
      });
      const count = spec.pageCount ?? null;
      const indices: Array<number | null> =
        count === null ? [null] : Array.from({ length: count }, (unused, index) => index);
      await testPrisma().documentPage.createMany({
        data: indices.map((pageIndex, offset) => ({
          documentId: document.id,
          position: position + offset,
          fileId: file.id,
          pageIndex,
        })),
      });
      position += indices.length;
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
      fileIds.push(file.id);
    }

    return { documentId: document.id, libraryId: library.id, fileIds };
  }

  const detailOf = async (documentId: string, cookie = adminCookie): Promise<DocumentDetailDto> =>
    expectData(
      await api(app).get(`/api/documents/${documentId}`).set('Cookie', cookie),
      documentDetailDtoSchema,
    );

  // What the document reads as: one entry per page, said as "file:index", which is the whole of what
  // these routes move about.
  const orderOf = (document: DocumentDetailDto): string[] =>
    document.pages.map(
      (page) => `${page.fileId}:${page.pageIndex === null ? 'whole' : page.pageIndex}`,
    );

  // An upload of our own bytes: the one kind of document whose access rule is ownership rather than
  // a library grant (docs/03 §3.4), which is what an edit refusal needs.
  const uploadDocument = async (
    body: Buffer,
    name: string,
    cookie = adminCookie,
  ): Promise<string> => {
    const res = await api(app)
      .postBinary('/api/documents', body)
      .set('Cookie', cookie)
      .set('X-Legere-Filename', encodeURIComponent(name));
    return expectData(res, uploadDocumentResponseSchema).document.id;
  };

  const rebuildsOf = (documentId: string): Promise<Array<{ data: { documentId: string } }>> =>
    testPrisma().$queryRawUnsafe(
      `SELECT data FROM pgboss.job WHERE name = 'document-process' AND data->>'documentId' = '${documentId}'`,
    );

  describe('a file inserted at a position', () => {
    it('puts a photograph between page two and page three of a five-page scan', async () => {
      const { documentId, fileIds } = await givenDocument([{ name: 'scan.pdf', pageCount: 5 }]);
      const scan = fileIds[0] ?? '';

      const res = await api(app)
        .postBinary(`/api/documents/${documentId}/files?at=2`, await pictureOf(8))
        .set('Cookie', adminCookie)
        .set('X-Legere-Filename', encodeURIComponent('photo.jpg'));

      expect(res.status).toBe(201);
      const document = expectData(res, documentDetailDtoSchema);
      const photo = document.files.find((file) => file.name === 'photo.jpg')?.id ?? '';
      // Six pages, and the photograph is the third of them (docs/05 §5.6).
      expect(orderOf(document)).toEqual([
        `${scan}:0`,
        `${scan}:1`,
        `${photo}:whole`,
        `${scan}:2`,
        `${scan}:3`,
        `${scan}:4`,
      ]);
      // Positions stay 0-based and contiguous whatever is spliced into the middle.
      expect(document.pages.map((page) => page.position)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(await rebuildsOf(documentId)).toHaveLength(1);
    });

    it('appends when nothing says where, and refuses a position past the end', async () => {
      const { documentId, fileIds } = await givenDocument([{ name: 'scan.pdf', pageCount: 2 }]);

      const appended = await api(app)
        .postBinary(`/api/documents/${documentId}/files`, await pictureOf(8))
        .set('Cookie', adminCookie)
        .set('X-Legere-Filename', encodeURIComponent('last.png'));
      expect(appended.status).toBe(201);
      expect(expectData(appended, documentDetailDtoSchema).pages.at(-1)?.fileId).not.toBe(
        fileIds[0],
      );

      const past = await api(app)
        .postBinary(`/api/documents/${documentId}/files?at=9`, await pictureOf(9))
        .set('Cookie', adminCookie)
        .set('X-Legere-Filename', encodeURIComponent('nowhere.png'));

      expect(past.status).toBe(422);
      expect(expectError(past).code).toBe('VALIDATION_FAILED');
      // 🔒 Refused before anything was stored: the document holds what it held.
      expect((await detailOf(documentId)).pages).toHaveLength(3);
    });
  });

  describe('the whole order', () => {
    it('rewrites the order the client sends, across the boundary between two files', async () => {
      const { documentId } = await givenDocument([
        { name: 'scan.pdf', pageCount: 2 },
        { name: 'photo.jpg', mimeType: 'image/jpeg', pageCount: 1 },
      ]);
      const before = await detailOf(documentId);
      const ids = before.pages.map((page) => page.id);
      const order = [ids[0] ?? '', ids[2] ?? '', ids[1] ?? ''];

      const res = await api(app)
        .patch(`/api/documents/${documentId}/pages`, { order })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const after = expectData(res, documentDetailDtoSchema);
      expect(after.pages.map((page) => page.id)).toEqual(order);
      expect(orderOf(after)).toEqual([
        orderOf(before)[0] ?? '',
        orderOf(before)[2] ?? '',
        orderOf(before)[1] ?? '',
      ]);
      expect(await rebuildsOf(documentId)).toHaveLength(1);
    });

    it('refuses an order that is not the whole document, and changes nothing', async () => {
      const { documentId } = await givenDocument([{ name: 'scan.pdf', pageCount: 3 }]);
      const before = await detailOf(documentId);

      const partial = await api(app)
        .patch(`/api/documents/${documentId}/pages`, {
          order: [before.pages[0]?.id ?? ''],
        })
        .set('Cookie', adminCookie);

      expect(partial.status).toBe(422);
      expect(expectError(partial).code).toBe('VALIDATION_FAILED');
      expect((await detailOf(documentId)).pages.map((page) => page.id)).toEqual(
        before.pages.map((page) => page.id),
      );
      expect(await rebuildsOf(documentId)).toHaveLength(0);
    });
  });

  // How one page lies and how much of it is paper (docs/07 §7.3, docs/03 §3.3.17). A crop is taken
  // on any page there is — the promise the model makes about a page of a PDF — and only the mirror
  // stays an image's own.
  describe('one page cropped and turned', () => {
    const crop = {
      points: [
        [0.1, 0.1],
        [0.9, 0.12],
        [0.88, 0.9],
        [0.12, 0.88],
      ],
    };

    it('crops a page of a PDF and turns another, one edit and one rebuild each', async () => {
      const { documentId } = await givenDocument([{ name: 'scan.pdf', pageCount: 3 }]);
      const before = await detailOf(documentId);

      const cropped = await api(app)
        .patch(`/api/documents/${documentId}/pages/${before.pages[1]?.id ?? ''}`, {
          crop,
          turn: { quarterTurns: 1, mirrored: false },
        })
        .set('Cookie', adminCookie);

      expect(cropped.status).toBe(200);
      const after = expectData(cropped, documentDetailDtoSchema);
      expect(after.pages[1]).toMatchObject({
        crop,
        // 🔒 MANUAL is what stops a rebuild from replacing it with what a detector found.
        cropSource: 'MANUAL',
        turn: { quarterTurns: 1, mirrored: false },
      });
      // The pages either side of it are untouched: a crop is a statement about one page.
      expect(after.pages[0]).toMatchObject({ crop: null, cropSource: 'NONE', turn: null });
      expect(after.pages[2]).toMatchObject({ crop: null, cropSource: 'NONE', turn: null });
      // One edit, one rebuild — not one per key (docs/05 §5.6).
      expect(await rebuildsOf(documentId)).toHaveLength(1);
    });

    it('clears both back to the way the page arrived', async () => {
      const { documentId } = await givenDocument([{ name: 'scan.pdf', pageCount: 2 }]);
      const pageId = (await detailOf(documentId)).pages[0]?.id ?? '';
      await api(app)
        .patch(`/api/documents/${documentId}/pages/${pageId}`, {
          crop,
          turn: { quarterTurns: 2, mirrored: false },
        })
        .set('Cookie', adminCookie);

      const cleared = await api(app)
        .patch(`/api/documents/${documentId}/pages/${pageId}`, { crop: null, turn: null })
        .set('Cookie', adminCookie);

      // Nothing to undo: both were instructions beside bytes nobody rewrote (docs/03 §3.3.17).
      expect(expectData(cleared, documentDetailDtoSchema).pages[0]).toMatchObject({
        crop: null,
        cropSource: 'NONE',
        turn: null,
      });
    });

    it('mirrors a page of an image and refuses a mirror anywhere else', async () => {
      const { documentId } = await givenDocument([
        { name: 'photo.jpg', mimeType: 'image/jpeg', pageCount: 1 },
        { name: 'scan.pdf', pageCount: 2 },
      ]);
      const before = await detailOf(documentId);

      const mirrored = await api(app)
        .patch(`/api/documents/${documentId}/pages/${before.pages[0]?.id ?? ''}`, {
          turn: { quarterTurns: 1, mirrored: true },
        })
        .set('Cookie', adminCookie);
      expect(mirrored.status).toBe(200);
      expect(expectData(mirrored, documentDetailDtoSchema).pages[0]?.turn).toEqual({
        quarterTurns: 1,
        mirrored: true,
      });

      // 🔒 A page of a PDF arrives the way its producer laid it out and turns in quarters.
      const refused = await api(app)
        .patch(`/api/documents/${documentId}/pages/${before.pages[1]?.id ?? ''}`, {
          turn: { quarterTurns: 1, mirrored: true },
        })
        .set('Cookie', adminCookie);
      expect(refused.status).toBe(422);
      expect(expectError(refused).code).toBe('FILE_NOT_IMAGE');
      expect((await detailOf(documentId)).pages[1]?.turn).toBeNull();
    });

    it('refuses a page of another document, an empty body and a corner off the page', async () => {
      const { documentId } = await givenDocument([{ name: 'scan.pdf', pageCount: 2 }]);
      const { documentId: elsewhere } = await givenDocument([{ name: 'other.pdf', pageCount: 1 }]);
      const foreign = (await detailOf(elsewhere)).pages[0]?.id ?? '';
      const pageId = (await detailOf(documentId)).pages[0]?.id ?? '';

      const notHere = await api(app)
        .patch(`/api/documents/${documentId}/pages/${foreign}`, { crop: null })
        .set('Cookie', adminCookie);
      expect(notHere.status).toBe(404);
      expect(expectError(notHere).code).toBe('PAGE_NOT_FOUND');

      for (const body of [
        {},
        {
          crop: {
            points: [
              [0, 0],
              [1.5, 0],
              [1, 1],
              [0, 1],
            ],
          },
        },
        { turn: { quarterTurns: 4, mirrored: false } },
      ]) {
        const res = await api(app)
          .patch(`/api/documents/${documentId}/pages/${pageId}`, body)
          .set('Cookie', adminCookie);
        expect(res.status).toBe(422);
        expect(expectError(res).code).toBe('VALIDATION_FAILED');
      }

      expect(await rebuildsOf(documentId)).toHaveLength(0);
    });

    it('refuses somebody who may not edit the document', async () => {
      const stranger = await inviteUser(`pagecrop${(seq += 1)}@legere.local`);
      const documentId = await uploadDocument(await pictureOf(11), 'mine.png');
      const pageId = (await detailOf(documentId)).pages[0]?.id ?? '';

      const res = await api(app)
        .patch(`/api/documents/${documentId}/pages/${pageId}`, { crop })
        .set('Cookie', stranger.cookie);

      // Not theirs to read, so not theirs to find (docs/03 §3.4).
      expect(res.status).toBe(404);
    });
  });

  describe('a page removed', () => {
    it('takes the page out and rebuilds', async () => {
      const { documentId, fileIds } = await givenDocument([{ name: 'scan.pdf', pageCount: 3 }]);
      const before = await detailOf(documentId);

      const res = await api(app)
        .delete(`/api/documents/${documentId}/pages/${before.pages[1]?.id ?? ''}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const after = expectData(res, documentDetailDtoSchema);
      expect(after.pages.map((page) => page.pageIndex)).toEqual([0, 2]);
      // 🔒 Two pages still read the file, so nothing goes near the trash (docs/05 §5.7a).
      expect(await testPrisma().file.findUnique({ where: { id: fileIds[0] ?? '' } })).toMatchObject(
        {
          trashedAt: null,
        },
      );
      expect(await rebuildsOf(documentId)).toHaveLength(1);
    });

    it('sends the file to the trash when its last page leaves', async () => {
      const { documentId, fileIds } = await givenDocument([
        { name: 'scan.pdf', pageCount: 2 },
        { name: 'stray.jpg', mimeType: 'image/jpeg', pageCount: 1 },
      ]);
      const stray = fileIds[1] ?? '';
      const before = await detailOf(documentId);
      const page = before.pages.find((entry) => entry.fileId === stray);

      await api(app)
        .delete(`/api/documents/${documentId}/pages/${page?.id ?? ''}`)
        .set('Cookie', adminCookie);

      const trash = expectData(
        await api(app).get('/api/admin/trash').set('Cookie', adminCookie),
        listTrashResponseSchema,
      );
      expect(trash.items).toHaveLength(1);
      expect(trash.items[0]).toMatchObject({ id: stray, reason: 'PAGE_REMOVED' });
      // Under the title of the document it left, which is what will still say what it was.
      expect(trash.items[0]?.trashedFrom).toMatch(/^Scan /);
      // 🔒 And its ref is excluded, so the next scan does not ingest the same bytes into a brand-new
      // document (docs/03 §3.3.9).
      expect(await testPrisma().fileRef.findFirst({ where: { path: 'stray.jpg' } })).toMatchObject({
        status: 'EXCLUDED',
        fileId: null,
      });
      // 🔒 And the file the document still reads is untouched.
      expect(await testPrisma().file.findUnique({ where: { id: fileIds[0] ?? '' } })).toMatchObject(
        {
          trashedAt: null,
        },
      );
    });

    it('refuses the only page there is, and a page of another document', async () => {
      const one = await givenDocument([{ name: 'only.pdf', pageCount: 1 }]);
      const other = await givenDocument([{ name: 'elsewhere.pdf', pageCount: 2 }]);
      const only = (await detailOf(one.documentId)).pages[0]?.id ?? '';
      const foreign = (await detailOf(other.documentId)).pages[0]?.id ?? '';

      const last = await api(app)
        .delete(`/api/documents/${one.documentId}/pages/${only}`)
        .set('Cookie', adminCookie);
      expect(last.status).toBe(422);
      expect(expectError(last).code).toBe('DOCUMENT_LAST_PAGE');

      const elsewhere = await api(app)
        .delete(`/api/documents/${one.documentId}/pages/${foreign}`)
        .set('Cookie', adminCookie);
      expect(elsewhere.status).toBe(404);
      expect(expectError(elsewhere).code).toBe('PAGE_NOT_FOUND');

      expect((await detailOf(one.documentId)).pages).toHaveLength(1);
      expect(await rebuildsOf(one.documentId)).toHaveLength(0);
    });
  });

  describe('a document cut at a page', () => {
    it('cuts a twelve-page scan at eight, over the same file, and links the halves', async () => {
      const { documentId, fileIds } = await givenDocument([
        { name: 'two-deeds.pdf', pageCount: 12 },
      ]);
      const scan = fileIds[0] ?? '';

      const res = await api(app)
        .post(`/api/documents/${documentId}/split`, { at: [8] })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const answer = expectData(res, splitDocumentResponseSchema);
      const madeId = answer.splitDocumentIds[0] ?? '';
      expect(answer.document.pages.map((page) => page.pageIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

      const made = await detailOf(madeId);
      expect(made.pages.map((page) => page.pageIndex)).toEqual([8, 9, 10, 11]);
      // 🔒 One file, read by pages in two documents: no bytes copied, nothing extracted (ADR-025).
      expect(made.files.map((file) => file.id)).toEqual([scan]);
      expect(await testPrisma().file.count()).toBe(1);
      // Titled after the file its first page comes from and nothing else it has not earned.
      expect(made.title).toBe('two-deeds');
      expect(made.documentType).toBeNull();
      expect(made.people).toEqual([]);

      // The halves are linked to each other (ADR-023), which is what makes them separate-but-together.
      const linked = expectData(
        await api(app).get(`/api/documents/${documentId}/links`).set('Cookie', adminCookie),
        documentLinksResponseSchema,
      );
      expect(linked.items.map((item) => item.document.id)).toEqual([madeId]);

      // Both sides rebuild: each is a different document to read now.
      expect(await rebuildsOf(documentId)).toHaveLength(1);
      expect(await rebuildsOf(madeId)).toHaveLength(1);
    });

    it('refuses a cut at the first page or past the last, and changes nothing', async () => {
      const { documentId } = await givenDocument([{ name: 'scan.pdf', pageCount: 3 }]);

      for (const at of [[0], [3], [1, 1]]) {
        const res = await api(app)
          .post(`/api/documents/${documentId}/split`, { at })
          .set('Cookie', adminCookie);
        expect(res.status).toBe(422);
        expect(expectError(res).code).toBe('VALIDATION_FAILED');
      }

      expect((await detailOf(documentId)).pages).toHaveLength(3);
      expect(await testPrisma().document.count()).toBe(1);
      expect(await rebuildsOf(documentId)).toHaveLength(0);
    });
  });

  describe('pages moved to another document', () => {
    it('moves a page between two documents, and both hold what they should afterwards', async () => {
      const from = await givenDocument([{ name: 'mixed.pdf', pageCount: 3 }]);
      const to = await givenDocument([{ name: 'target.pdf', pageCount: 2 }]);
      const moving = (await detailOf(from.documentId)).pages[2]?.id ?? '';

      const res = await api(app)
        .post(`/api/documents/${from.documentId}/pages/move`, {
          pageIds: [moving],
          documentId: to.documentId,
          at: 1,
        })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const answer = expectData(res, moveDocumentPagesResponseSchema);
      expect(answer.movedToDocumentId).toBe(to.documentId);
      expect(answer.document.pages.map((page) => page.pageIndex)).toEqual([0, 1]);

      const target = await detailOf(to.documentId);
      expect(orderOf(target)).toEqual([
        `${to.fileIds[0] ?? ''}:0`,
        `${from.fileIds[0] ?? ''}:2`,
        `${to.fileIds[0] ?? ''}:1`,
      ]);
      // 🔒 Both files are still exactly where they were: an entry changed hands, not a byte.
      expect(await testPrisma().file.count({ where: { trashedAt: { not: null } } })).toBe(0);
      expect(await rebuildsOf(from.documentId)).toHaveLength(1);
      expect(await rebuildsOf(to.documentId)).toHaveLength(1);
    });

    it('makes a document to hold them when asked for a new one', async () => {
      const from = await givenDocument([
        { name: 'scan.pdf', pageCount: 2 },
        { name: 'photo.jpg', mimeType: 'image/jpeg', pageCount: 1 },
      ]);
      const photo = (await detailOf(from.documentId)).pages[2]?.id ?? '';

      const res = await api(app)
        .post(`/api/documents/${from.documentId}/pages/move`, {
          pageIds: [photo],
          documentId: null,
        })
        .set('Cookie', adminCookie);

      const answer = expectData(res, moveDocumentPagesResponseSchema);
      const made = await detailOf(answer.movedToDocumentId);
      expect(made.title).toBe('photo');
      expect(orderOf(made)).toEqual([`${from.fileIds[1] ?? ''}:0`]);
      expect(answer.document.pages.map((page) => page.pageIndex)).toEqual([0, 1]);
    });

    it('🔒 refuses a move into a document the mover may read but not edit, whole', async () => {
      const invited = await inviteUser(`mover${seq}@legere.local`);
      // Documents of uploaded bytes, whose access rule is ownership rather than a library grant
      // (docs/03 §3.4): one the mover's own, two pages long — and one of the admin's, shared with
      // them through a collection, which grants reading and never editing.
      const mine = await uploadDocument(
        Buffer.concat([PDF, Buffer.from('mine')]),
        'mine.pdf',
        invited.cookie,
      );
      const added = await api(app)
        .postBinary(`/api/documents/${mine}/files`, Buffer.concat([PDF, Buffer.from('second')]))
        .set('Cookie', invited.cookie)
        .set('X-Legere-Filename', encodeURIComponent('second.pdf'));
      expect(added.status).toBe(201);

      const theirs = await uploadDocument(
        Buffer.concat([PDF, Buffer.from('theirs')]),
        'theirs.pdf',
      );
      const collection = await api(app)
        .post('/api/collections', { name: `Shared ${seq}` })
        .set('Cookie', adminCookie);
      const collectionId = expectData(collection, collectionDtoSchema).id;
      await api(app)
        .post(`/api/collections/${collectionId}/items`, { documentId: theirs })
        .set('Cookie', adminCookie);
      await api(app)
        .post(`/api/collections/${collectionId}/shares`, { granteeUserId: invited.id })
        .set('Cookie', adminCookie);
      // The share is what makes this a 403 rather than a 404: the mover can see the document.
      expect((await detailOf(theirs, invited.cookie)).pages).toHaveLength(1);

      const moving = (await detailOf(mine, invited.cookie)).pages[0]?.id ?? '';
      const res = await api(app)
        .post(`/api/documents/${mine}/pages/move`, {
          pageIds: [moving],
          documentId: theirs,
        })
        .set('Cookie', invited.cookie);

      expect(res.status).toBe(403);
      expect(expectError(res).code).toBe('FORBIDDEN');
      // Refused whole rather than done by halves: neither document moved a page.
      expect((await detailOf(mine, invited.cookie)).pages).toHaveLength(2);
      expect((await detailOf(theirs)).pages).toHaveLength(1);
    });

    it('refuses a move that would empty the document, and one into a document nobody can see', async () => {
      const from = await givenDocument([{ name: 'scan.pdf', pageCount: 2 }]);
      const to = await givenDocument([{ name: 'target.pdf', pageCount: 1 }]);
      const pages = (await detailOf(from.documentId)).pages.map((page) => page.id);

      const emptied = await api(app)
        .post(`/api/documents/${from.documentId}/pages/move`, {
          pageIds: pages,
          documentId: to.documentId,
        })
        .set('Cookie', adminCookie);
      expect(emptied.status).toBe(422);
      expect(expectError(emptied).code).toBe('DOCUMENT_LAST_PAGE');

      const nowhere = await api(app)
        .post(`/api/documents/${from.documentId}/pages/move`, {
          pageIds: [pages[0] ?? ''],
          documentId: '11111111-2222-4222-8222-333333333333',
        })
        .set('Cookie', adminCookie);
      expect(nowhere.status).toBe(404);
      expect(expectError(nowhere).code).toBe('DOCUMENT_NOT_FOUND');

      expect((await detailOf(from.documentId)).pages).toHaveLength(2);
      expect((await detailOf(to.documentId)).pages).toHaveLength(1);
      expect(await rebuildsOf(from.documentId)).toHaveLength(0);
    });
  });
});
