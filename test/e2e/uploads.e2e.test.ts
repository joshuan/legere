import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import {
  listDocumentsResponseSchema,
  uploadDocumentResponseSchema,
} from '../../src/shared/contracts/documents';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';
// A real PDF header, so content detection has something to recognise.
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n');

// Uploading a document from the browser (docs/05 §5.1a, docs/07 §7.3).
describe('Uploads (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let seq = 0;

  beforeAll(async () => {
    // A small cap keeps the oversize case honest without pushing 100 MiB through the heap.
    app = await createTestApp({ uploadMaxBytes: 4096 });
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    app.files.clear();
    seq += 1;
    adminCookie = await onboard(`uploader${seq}@legere.local`);
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
    const cookie = cookieNamed(completed, 'sid');
    if (cookie === undefined) throw new Error('invited user has no session');
    return cookie;
  }

  const upload = (cookie: string, body: Buffer, fileName: string) =>
    api(app)
      .postBinary('/api/documents', body)
      .set('Cookie', cookie)
      .set('X-Legere-Filename', encodeURIComponent(fileName));

  const processJobs = (): Promise<{ data: { documentId: string } }[]> =>
    testPrisma().$queryRawUnsafe(
      "SELECT data FROM pgboss.job WHERE name = 'document-process' ORDER BY created_on",
    );

  it('stores the bytes in the bucket and starts the pipeline', async () => {
    const res = await upload(adminCookie, PDF, 'Contract 2026.pdf');

    expect(res.status).toBe(201);
    const { document, created } = expectData(res, uploadDocumentResponseSchema);
    expect(created).toBe(true);
    // The file name becomes the title, minus its extension (docs/03 §3.3.10).
    expect(document).toMatchObject({
      title: 'Contract 2026',
      fileCount: 1,
      primaryExt: 'pdf',
      // The bytes are ours, so the document is managed and can never be "missing" the way a library
      // file can (docs/03 §3.3.10).
      origin: 'MANAGED',
      availability: 'AVAILABLE',
      processing: true,
      sizeBytes: String(PDF.byteLength),
    });

    // 🔒 The library volume is read-only and stays untouched: the bytes are in the bucket, under the
    // file's own key (docs/09 §9.2).
    const file = await testPrisma().file.findFirstOrThrow({
      where: { contentHash: createHash('sha256').update(PDF).digest('hex') },
    });
    expect(file.origin).toBe('MANAGED');
    expect(file.mimeType).toBe('application/pdf');
    expect(app.files.get(artifactKeys.fileOriginal(file.id, 'pdf')).body).toEqual(PDF);
    expect((await processJobs())[0]?.data.documentId).toBe(document.id);

    const row = await testPrisma().document.findUniqueOrThrow({ where: { id: document.id } });
    expect(row.createdById).not.toBeNull();
    // The document holds exactly that one file (docs/03 §3.3.17).
    const held = await testPrisma().documentFile.findMany({ where: { documentId: document.id } });
    expect(held).toMatchObject([{ position: 0, fileId: file.id }]);
  });

  it('detects the format from the content, not from the name it was given', async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
      Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
      Buffer.alloc(16),
    ]);

    const res = await upload(adminCookie, png, 'invoice.pdf');

    const { document } = expectData(res, uploadDocumentResponseSchema);
    expect(document.primaryExt).toBe('png');
    const file = await testPrisma().file.findFirstOrThrow({ where: { name: 'invoice.pdf' } });
    expect(file.mimeType).toBe('image/png');
    expect(file.ext).toBe('png');
  });

  it('appears in the listing like any other document, and only to its owner', async () => {
    const uploaded = expectData(
      await upload(adminCookie, PDF, 'Private.pdf'),
      uploadDocumentResponseSchema,
    ).document;
    const otherCookie = await inviteUser(`nosy${seq}@legere.local`);

    const mine = expectData(
      await api(app).get('/api/documents?origin=MANAGED').set('Cookie', adminCookie),
      listDocumentsResponseSchema,
    );
    expect(mine.items.map((item) => item.id)).toEqual([uploaded.id]);

    // 🔒 An upload belongs to whoever made it: a document with no library file is its creator's
    // (docs/03 §3.4).
    const theirs = expectData(
      await api(app).get('/api/documents').set('Cookie', otherCookie),
      listDocumentsResponseSchema,
    );
    expect(theirs.items).toEqual([]);
    expect(
      (await api(app).get(`/api/documents/${uploaded.id}`).set('Cookie', otherCookie)).status,
    ).toBe(404);
  });

  it('resolves to the document it already has when the same bytes come back', async () => {
    const first = expectData(
      await upload(adminCookie, PDF, 'Contract.pdf'),
      uploadDocumentResponseSchema,
    );

    const second = expectData(
      await upload(adminCookie, PDF, 'Contract copy.pdf'),
      uploadDocumentResponseSchema,
    );

    // Deduplication is the whole point of ADR-009, one level down (ADR-021): one content, one file,
    // and the document that already holds it.
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(await testPrisma().document.count()).toBe(1);
    expect(await testPrisma().file.count()).toBe(1);
    // And the pipeline ran once, not twice.
    expect(await processJobs()).toHaveLength(1);
  });

  it('refuses content that already exists in a document the uploader cannot read', async () => {
    await upload(adminCookie, PDF, 'Admin only.pdf');
    const otherCookie = await inviteUser(`outsider${seq}@legere.local`);

    const res = await upload(otherCookie, PDF, 'Mine too.pdf');

    // 🔒 Resolving would hand somebody else's document to a stranger; refusing is the honest answer.
    expect(res.status).toBe(409);
    expect(expectError(res).code).toBe('DOCUMENT_DUPLICATE');
  });

  it('rejects a body over the instance limit, and one with no name at all', async () => {
    const tooBig = Buffer.alloc(app.uploadMaxBytes + 1, 0x41);

    const oversized = await upload(adminCookie, tooBig, 'huge.bin');
    expect(oversized.status).toBe(413);

    const unnamed = await api(app).postBinary('/api/documents', PDF).set('Cookie', adminCookie);
    expect(unnamed.status).toBe(422);

    expect(await testPrisma().document.count()).toBe(0);
  });

  it('takes the file whatever Content-Type the client puts on it', async () => {
    // curl with no explicit type sends application/x-www-form-urlencoded; a body parser reading that
    // would leave the handler an empty request (which is exactly what happened once).
    // superagent re-encodes a Buffer for form content types, so the bytes here are not a real PDF —
    // what matters is that the request reaches the handler with a body at all, which is exactly what
    // a body parser on this route destroyed.
    const res = await api(app)
      .post('/api/documents')
      .set('Cookie', adminCookie)
      .set('X-Legere-Filename', 'form.txt')
      .type('application/x-www-form-urlencoded')
      .send('plain text, sent as a form');

    expect(res.status).toBe(201);
    expect(
      Number(expectData(res, uploadDocumentResponseSchema).document.sizeBytes),
    ).toBeGreaterThan(0);
  });

  it('refuses an anonymous caller', async () => {
    const res = await api(app).post('/api/documents').set('X-Legere-Filename', 'x.pdf').send(PDF);

    expect(res.status).toBe(401);
  });
});
