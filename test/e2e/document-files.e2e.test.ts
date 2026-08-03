import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { documentMarkdownResponseSchema } from '../../src/shared/contracts/documents';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
const FILE_BODY = 'the bytes of the original file';

// A streamed binary body arrives as a Buffer rather than in `res.text`.
function bodyOf(res: { body: unknown; text?: string }): string {
  if (Buffer.isBuffer(res.body)) return res.body.toString();
  return res.text ?? '';
}

// The file endpoints (docs/07 §7.3, docs/09 §9.1–9.2): library bytes stream through the app,
// derived artifacts are handed over as short-lived signed URLs.
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

  type Fixture = {
    documentId: string;
    fileName: string;
    libraryId: string;
  };

  // A library document backed by a real file on the volume, the way a scan would have left it.
  async function givenLibraryDocument(
    overrides: {
      title?: string;
      visibility?: 'ALL_USERS' | 'RESTRICTED';
      mimeType?: string;
      ext?: string;
      previewStatus?: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
      canonicalStatus?: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
      markdown?: string | null;
      writeFile?: boolean;
    } = {},
  ): Promise<Fixture> {
    contentSeq += 1;
    const fileName = `file-${contentSeq}.pdf`;
    const library = await testPrisma().library.create({
      data: {
        name: `Files ${contentSeq}`,
        rootPath: folder,
        visibility: overrides.visibility ?? 'ALL_USERS',
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });

    if (overrides.writeFile !== false) {
      await writeFile(join(libraryRoot, folder, fileName), FILE_BODY);
    }

    const document = await testPrisma().document.create({
      data: {
        contentHash: `${contentSeq}`.padStart(64, 'b'),
        source: 'LIBRARY',
        mimeType: overrides.mimeType ?? 'application/pdf',
        ext: overrides.ext ?? 'pdf',
        sizeBytes: BigInt(Buffer.byteLength(FILE_BODY)),
        title: overrides.title ?? `Document ${contentSeq}`,
        markdown: overrides.markdown ?? null,
        canonicalStatus: overrides.canonicalStatus ?? 'SKIPPED',
        previewStatus: overrides.previewStatus ?? 'DONE',
        markdownStatus: 'DONE',
        categorizationStatus: 'DONE',
        vectorizationStatus: 'SKIPPED',
      },
    });

    await testPrisma().fileRef.create({
      data: {
        libraryId: library.id,
        documentId: document.id,
        path: fileName,
        size: BigInt(Buffer.byteLength(FILE_BODY)),
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: `${contentSeq}`.padStart(64, 'b'),
      },
    });

    return { documentId: document.id, fileName, libraryId: library.id };
  }

  async function givenDerivedDocument(ownerId: string): Promise<string> {
    contentSeq += 1;
    const document = await testPrisma().document.create({
      data: {
        contentHash: `${contentSeq}`.padStart(64, 'a'),
        source: 'DERIVED',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 12n,
        title: 'Merged scan',
        createdById: ownerId,
        canonicalStatus: 'SKIPPED',
        previewStatus: 'DONE',
        markdownStatus: 'DONE',
        categorizationStatus: 'DONE',
        vectorizationStatus: 'SKIPPED',
      },
    });
    return document.id;
  }

  describe('source', () => {
    it('streams a library file with its length, type and file name', async () => {
      const { documentId } = await givenLibraryDocument({ title: 'Rental agreement' });

      // application/pdf is binary as far as the client is concerned, so the body is buffered
      // rather than read as text.
      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', adminCookie)
        .buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(FILE_BODY)));
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('filename="Rental agreement.pdf"');
      // 🔒 User content served from our own origin must not be sniffed into something executable.
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(bodyOf(res)).toBe(FILE_BODY);
    });

    it('encodes a non-ASCII title per RFC 5987 and still offers an ASCII fallback', async () => {
      const { documentId } = await givenLibraryDocument({ title: 'Счёт за январь' });

      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', adminCookie);

      const disposition = res.headers['content-disposition'] ?? '';
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).toContain(encodeURIComponent('Счёт за январь.pdf'));
      // The plain parameter stays ASCII, or old clients mangle the whole header.
      const plain = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';

      expect(/^[\x20-\x7e]*$/.test(plain)).toBe(true);
    });

    it('marks the ref MISSING and answers DOCUMENT_UNAVAILABLE when the file has vanished', async () => {
      const { documentId, fileName } = await givenLibraryDocument();
      await rm(join(libraryRoot, folder, fileName));

      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('DOCUMENT_UNAVAILABLE');
      // The next listing tells the truth instead of offering a download that fails again.
      const ref = await testPrisma().fileRef.findFirstOrThrow({ where: { documentId } });
      expect(ref.status).toBe('MISSING');
      expect(ref.missingSince).not.toBeNull();
    });

    it('answers DOCUMENT_UNAVAILABLE when every ref is already MISSING', async () => {
      const { documentId } = await givenLibraryDocument();
      await testPrisma().fileRef.updateMany({
        where: { documentId },
        data: { status: 'MISSING', missingSince: new Date() },
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(409);
      expect(expectError(res).code).toBe('DOCUMENT_UNAVAILABLE');
    });

    it('redirects a derived document to a signed URL for its merged PDF', async () => {
      const owner = await inviteUser(`owner${seq}@legere.local`);
      const documentId = await givenDerivedDocument(owner.id);

      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', owner.cookie)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(artifactKeys.source(documentId, 'pdf'));
      // 🔒 Short-lived, never a permanent link (docs/08 §8.5).
      expect(res.headers.location).toContain('X-Amz-Expires=300');
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

    it('404s a preview the pipeline never produced', async () => {
      const { documentId } = await givenLibraryDocument({ previewStatus: 'SKIPPED' });

      const res = await api(app)
        .get(`/api/documents/${documentId}/preview`)
        .set('Cookie', adminCookie);

      // Better than a redirect to a URL that 404s from the bucket instead.
      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('NOT_FOUND');
    });

    it('redirects to the canonical PDF of a converted document', async () => {
      const { documentId } = await givenLibraryDocument({
        mimeType: 'application/vnd.oasis.opendocument.text',
        ext: 'odt',
        canonicalStatus: 'DONE',
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/canonical`)
        .set('Cookie', adminCookie)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(artifactKeys.canonicalPdf(documentId));
    });

    it('serves the source itself as the canonical PDF of a PDF', async () => {
      const { documentId } = await givenLibraryDocument();

      const res = await api(app)
        .get(`/api/documents/${documentId}/canonical`)
        .set('Cookie', adminCookie)
        .buffer(true);

      // A PDF has no canonical copy — it already is one (docs/07 §7.3).
      expect(res.status).toBe(200);
      expect(bodyOf(res)).toBe(FILE_BODY);
      expect(res.headers['content-disposition']).toContain('inline');
    });

    it('404s the canonical PDF of a document that has none', async () => {
      const { documentId } = await givenLibraryDocument({
        mimeType: 'text/plain',
        ext: 'txt',
        canonicalStatus: 'SKIPPED',
      });

      const res = await api(app)
        .get(`/api/documents/${documentId}/canonical`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
    });
  });

  describe('markdown', () => {
    it('returns the extracted text', async () => {
      const { documentId } = await givenLibraryDocument({ markdown: '# Invoice\n\nAmount due' });

      const res = await api(app)
        .get(`/api/documents/${documentId}/markdown`)
        .set('Cookie', adminCookie);

      expect(expectData(res, documentMarkdownResponseSchema).markdown).toBe(
        '# Invoice\n\nAmount due',
      );
    });

    it('returns null when there is no text rather than pretending there is', async () => {
      const { documentId } = await givenLibraryDocument({ markdown: null });

      const res = await api(app)
        .get(`/api/documents/${documentId}/markdown`)
        .set('Cookie', adminCookie);

      expect(expectData(res, documentMarkdownResponseSchema).markdown).toBeNull();
    });
  });

  describe('authorization', () => {
    it('refuses every file route exactly like the metadata routes', async () => {
      const { documentId } = await givenLibraryDocument({ visibility: 'RESTRICTED' });
      const outsider = await inviteUser(`outsider${seq}@legere.local`);

      for (const path of ['source', 'preview', 'thumb', 'canonical', 'markdown']) {
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

    it('lets a granted user download the same file', async () => {
      const { documentId, libraryId } = await givenLibraryDocument({ visibility: 'RESTRICTED' });
      const user = await inviteUser(`granted${seq}@legere.local`);
      await testPrisma().libraryAccess.create({ data: { libraryId, userId: user.id } });

      const res = await api(app)
        .get(`/api/documents/${documentId}/source`)
        .set('Cookie', user.cookie)
        .buffer(true);

      expect(res.status).toBe(200);
      expect(bodyOf(res)).toBe(FILE_BODY);
    });
  });
});
