import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  listScanSetsResponseSchema,
  scanSetDetailSchema,
  scanSetDtoSchema,
} from '../../src/shared/contracts/scan-sets';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Scan sets (docs/07 §7.3, docs/03 §3.3.16–3.3.17, docs/05 §5.6): a stack of photographed pages
// becomes one PDF.
describe('Scan sets (e2e)', () => {
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
    adminCookie = await onboard(`scansetadmin${seq}@legere.local`);
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

  async function givenLibrary(): Promise<string> {
    contentSeq += 1;
    const library = await testPrisma().library.create({
      data: {
        name: `Scans ${contentSeq}`,
        rootPath: `scans-${contentSeq}`,
        visibility: 'ALL_USERS',
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    return library.id;
  }

  async function givenImage(libraryId: string, title = 'Page'): Promise<string> {
    contentSeq += 1;
    const hash = `${contentSeq}`.padStart(64, '5');
    const document = await testPrisma().document.create({
      data: {
        contentHash: hash,
        source: 'LIBRARY',
        mimeType: 'image/jpeg',
        ext: 'jpg',
        sizeBytes: 100n,
        title: `${title} ${contentSeq}`,
        previewStatus: 'DONE',
      },
    });
    await testPrisma().fileRef.create({
      data: {
        libraryId,
        documentId: document.id,
        path: `page-${contentSeq}.jpg`,
        size: 100n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: hash,
      },
    });
    return document.id;
  }

  async function givenPdfDocument(libraryId: string): Promise<string> {
    contentSeq += 1;
    const hash = `${contentSeq}`.padStart(64, '6');
    const document = await testPrisma().document.create({
      data: {
        contentHash: hash,
        source: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 100n,
        title: `Not an image ${contentSeq}`,
      },
    });
    await testPrisma().fileRef.create({
      data: {
        libraryId,
        documentId: document.id,
        path: `doc-${contentSeq}.pdf`,
        size: 100n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: hash,
      },
    });
    return document.id;
  }

  const create = (cookie: string, body: Record<string, unknown>) =>
    api(app).post('/api/scan-sets', body).set('Cookie', cookie);

  it('creates a set in page order and lists it as DRAFT', async () => {
    const libraryId = await givenLibrary();
    const first = await givenImage(libraryId, 'First');
    const second = await givenImage(libraryId, 'Second');

    const created = await create(adminCookie, {
      name: 'Passport',
      items: [second, first],
    });

    expect(created.status).toBe(201);
    const detail = expectData(created, scanSetDetailSchema);
    expect(detail).toMatchObject({
      name: 'Passport',
      status: 'DRAFT',
      cropMode: 'TRIM',
      itemCount: 2,
    });
    // The order of the request is the page order (docs/07 §7.3).
    expect(detail.items.map((item) => item.documentId)).toEqual([second, first]);

    const list = expectData(
      await api(app).get('/api/scan-sets').set('Cookie', adminCookie),
      listScanSetsResponseSchema,
    );
    expect(list.items.map((item) => item.id)).toEqual([detail.id]);
  });

  it('refuses a page that is not an image', async () => {
    const libraryId = await givenLibrary();
    const notAnImage = await givenPdfDocument(libraryId);

    const res = await create(adminCookie, { name: 'Wrong', items: [notAnImage] });

    expect(res.status).toBe(422);
    expect(expectError(res).code).toBe('SCANSET_ITEM_NOT_IMAGE');
  });

  it('refuses a page the caller cannot read', async () => {
    const libraryId = await givenLibrary();
    await testPrisma().library.update({
      where: { id: libraryId },
      data: { visibility: 'RESTRICTED' },
    });
    const page = await givenImage(libraryId);
    const outsider = await inviteUser(`scanoutsider${seq}@legere.local`);

    const res = await create(outsider.cookie, { name: 'Not mine', items: [page] });

    // 🔒 A scan set is not a way to reach a document you cannot open (docs/03 §3.3.17).
    expect(res.status).toBe(403);
  });

  it('reorders and re-crops a DRAFT set', async () => {
    const libraryId = await givenLibrary();
    const one = await givenImage(libraryId);
    const two = await givenImage(libraryId);
    const set = expectData(
      await create(adminCookie, { name: 'Reorder', items: [one, two] }),
      scanSetDetailSchema,
    );

    const res = await api(app)
      .patch(`/api/scan-sets/${set.id}`, { items: [two, one], cropMode: 'NONE' })
      .set('Cookie', adminCookie);

    const updated = expectData(res, scanSetDetailSchema);
    expect(updated.items.map((item) => item.documentId)).toEqual([two, one]);
    expect(updated.cropMode).toBe('NONE');
    // Positions stay a contiguous 0-based order (docs/03 §3.3.17).
    expect(updated.items.map((item) => item.position)).toEqual([0, 1]);
  });

  it('queues a merge and refuses to edit the set while it is queued', async () => {
    const libraryId = await givenLibrary();
    const page = await givenImage(libraryId);
    const set = expectData(
      await create(adminCookie, { name: 'Passport', items: [page] }),
      scanSetDetailSchema,
    );

    const merged = await api(app).post(`/api/scan-sets/${set.id}/merge`).set('Cookie', adminCookie);
    expect(expectData(merged, scanSetDtoSchema).status).toBe('QUEUED');

    const jobs = await testPrisma().$queryRawUnsafe<{ data: { scanSetId: string } }[]>(
      "SELECT data FROM pgboss.job WHERE name = 'scanset-merge'",
    );
    expect(jobs[0]?.data.scanSetId).toBe(set.id);

    const edit = await api(app)
      .patch(`/api/scan-sets/${set.id}`, { name: 'Too late' })
      .set('Cookie', adminCookie);
    // 🔒 A merge in flight must not have the ground moved under it (docs/03 §3.3.16).
    expect(edit.status).toBe(409);
    expect(expectError(edit).code).toBe('SCANSET_INVALID_STATE');
  });

  it('lets a failed set be edited and merged again', async () => {
    const libraryId = await givenLibrary();
    const page = await givenImage(libraryId);
    const set = expectData(
      await create(adminCookie, { name: 'Retry', items: [page] }),
      scanSetDetailSchema,
    );
    await testPrisma().scanSet.update({
      where: { id: set.id },
      data: { status: 'FAILED', error: 'Stirling exploded' },
    });

    const edited = await api(app)
      .patch(`/api/scan-sets/${set.id}`, { name: 'Retry, fixed' })
      .set('Cookie', adminCookie);
    expect(edited.status).toBe(200);

    const merged = await api(app).post(`/api/scan-sets/${set.id}/merge`).set('Cookie', adminCookie);
    const queued = expectData(merged, scanSetDtoSchema);
    expect(queued.status).toBe('QUEUED');
    // The old error goes with the retry.
    expect(queued.error).toBeNull();
  });

  it('keeps a scan set private to its creator', async () => {
    const libraryId = await givenLibrary();
    const page = await givenImage(libraryId);
    const set = expectData(
      await create(adminCookie, { name: 'Private', items: [page] }),
      scanSetDetailSchema,
    );
    const other = await inviteUser(`scanother${seq}@legere.local`);

    const res = await api(app).get(`/api/scan-sets/${set.id}`).set('Cookie', other.cookie);

    expect(res.status).toBe(404);
    const theirList = expectData(
      await api(app).get('/api/scan-sets').set('Cookie', other.cookie),
      listScanSetsResponseSchema,
    );
    expect(theirList.items).toEqual([]);
  });

  it('deletes a scan set without touching its result document', async () => {
    const libraryId = await givenLibrary();
    const page = await givenImage(libraryId);
    const set = expectData(
      await create(adminCookie, { name: 'Deletable', items: [page] }),
      scanSetDetailSchema,
    );
    const result = await testPrisma().document.create({
      data: {
        contentHash: 'd'.repeat(64),
        source: 'DERIVED',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 10n,
        title: 'Merged',
        scanSetId: set.id,
      },
    });
    await testPrisma().scanSet.update({
      where: { id: set.id },
      data: { status: 'DONE', resultDocumentId: result.id },
    });

    const deleted = await api(app).delete(`/api/scan-sets/${set.id}`).set('Cookie', adminCookie);

    expect(deleted.status).toBe(200);
    // The result is a document in its own right now (docs/07 §7.3).
    const stillThere = await testPrisma().document.findUniqueOrThrow({ where: { id: result.id } });
    expect(stillThere.deletedAt).toBeNull();
  });

  it('404s a malformed id instead of failing inside the driver (docs/07 §7.1)', async () => {
    const res = await api(app).get('/api/scan-sets/not-a-uuid').set('Cookie', adminCookie);

    expect(res.status).toBe(404);
    expect(expectError(res).code).toBe('SCANSET_NOT_FOUND');
  });

  it('refuses an anonymous caller', async () => {
    expect((await api(app).get('/api/scan-sets')).status).toBe(401);
  });
});
