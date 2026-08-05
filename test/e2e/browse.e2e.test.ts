import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { browseResponseSchema } from '../../src/shared/contracts/libraries';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument } from '../helpers/documents';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Browse (docs/07 §7.3, docs/11 §11.4): folders are derived from the paths a scan recorded, at
// whatever depth the volume happens to have.
describe('Browse (e2e)', () => {
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
    adminCookie = await onboard(`browseadmin${seq}@legere.local`);
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

  async function givenLibrary(
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<string> {
    contentSeq += 1;
    const library = await testPrisma().library.create({
      data: {
        name: `Browse ${contentSeq}`,
        rootPath: `browse-${contentSeq}`,
        visibility,
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    return library.id;
  }

  // One document whose single file lies at exactly this path (docs/03 §3.3.16–17).
  async function givenFileAt(libraryId: string, path: string, title?: string): Promise<string> {
    const seeded = await seedDocument({
      document: {
        title: title ?? path.split('/').pop() ?? path,
        canonicalStatus: 'SKIPPED',
      },
      libraryId,
      files: [{ path, sizeBytes: 100n }],
    });
    return seeded.id;
  }

  const browse = (libraryId: string, cookie: string, query = '') =>
    api(app).get(`/api/libraries/${libraryId}/browse${query}`).set('Cookie', cookie);

  it('derives the top-level folders with the documents beneath them', async () => {
    const libraryId = await givenLibrary();
    await givenFileAt(libraryId, 'invoices/2026/january.pdf');
    await givenFileAt(libraryId, 'invoices/2026/february.pdf');
    await givenFileAt(libraryId, 'invoices/2025/december.pdf');
    await givenFileAt(libraryId, 'contracts/rental.pdf');
    const loose = await givenFileAt(libraryId, 'readme.pdf', 'Readme');

    const view = expectData(await browse(libraryId, adminCookie), browseResponseSchema);

    expect(view.path).toBe('');
    expect(view.folders).toEqual([
      { name: 'contracts', documentCount: 1 },
      // Counted through the whole subtree: a folder of folders is not an empty one.
      { name: 'invoices', documentCount: 3 },
    ]);
    // Only what sits directly here.
    expect(view.documents.items.map((item) => item.id)).toEqual([loose]);
  });

  it('descends to any depth', async () => {
    const libraryId = await givenLibrary();
    await givenFileAt(libraryId, 'a/b/c/d/deep.pdf', 'Deep');

    const level1 = expectData(
      await browse(libraryId, adminCookie, '?path=a'),
      browseResponseSchema,
    );
    expect(level1.folders).toEqual([{ name: 'b', documentCount: 1 }]);
    expect(level1.documents.items).toEqual([]);

    const bottom = expectData(
      await browse(libraryId, adminCookie, '?path=a/b/c/d'),
      browseResponseSchema,
    );
    expect(bottom.path).toBe('a/b/c/d');
    expect(bottom.folders).toEqual([]);
    expect(bottom.documents.items.map((item) => item.title)).toEqual(['Deep']);
  });

  it('sorts documents by title and paginates them', async () => {
    const libraryId = await givenLibrary();
    for (const title of ['Delta', 'Alpha', 'Charlie', 'Bravo']) {
      await givenFileAt(libraryId, `docs/${title.toLowerCase()}.pdf`, title);
    }

    const first = expectData(
      await browse(libraryId, adminCookie, '?path=docs&limit=2'),
      browseResponseSchema,
    );
    expect(first.documents.items.map((item) => item.title)).toEqual(['Alpha', 'Bravo']);
    expect(first.documents.nextCursor).not.toBeNull();

    const second = expectData(
      await browse(
        libraryId,
        adminCookie,
        `?path=docs&limit=2&cursor=${encodeURIComponent(first.documents.nextCursor ?? '')}`,
      ),
      browseResponseSchema,
    );
    expect(second.documents.items.map((item) => item.title)).toEqual(['Charlie', 'Delta']);
    expect(second.documents.nextCursor).toBeNull();
  });

  it('leaves a soft-deleted document out of both the folders and the listing', async () => {
    const libraryId = await givenLibrary();
    const documentId = await givenFileAt(libraryId, 'archive/old.pdf');
    await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

    const view = expectData(await browse(libraryId, adminCookie), browseResponseSchema);

    expect(view.folders).toEqual([]);
    expect(view.documents.items).toEqual([]);
  });

  it('shows an empty view for a folder that holds nothing', async () => {
    const libraryId = await givenLibrary();
    await givenFileAt(libraryId, 'invoices/a.pdf');

    const view = expectData(
      await browse(libraryId, adminCookie, '?path=nowhere'),
      browseResponseSchema,
    );

    expect(view).toMatchObject({ path: 'nowhere', folders: [] });
    expect(view.documents.items).toEqual([]);
  });

  describe('access and validation', () => {
    it('404s a library the caller cannot see, exactly like the listing hides it', async () => {
      const libraryId = await givenLibrary('RESTRICTED');
      await givenFileAt(libraryId, 'secret/plan.pdf');
      const outsider = await inviteUser(`browseoutsider${seq}@legere.local`);

      const res = await browse(libraryId, outsider.cookie);

      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('LIBRARY_NOT_FOUND');
    });

    it('opens the same library once the user is granted access', async () => {
      const libraryId = await givenLibrary('RESTRICTED');
      await givenFileAt(libraryId, 'secret/plan.pdf');
      const user = await inviteUser(`browsegranted${seq}@legere.local`);
      await testPrisma().libraryAccess.create({ data: { libraryId, userId: user.id } });

      const view = expectData(await browse(libraryId, user.cookie), browseResponseSchema);

      expect(view.folders).toEqual([{ name: 'secret', documentCount: 1 }]);
    });

    it('refuses a path that tries to climb out of the library', async () => {
      const libraryId = await givenLibrary();

      const res = await browse(libraryId, adminCookie, '?path=../../etc');

      // 🔒 Rejected by the contract before anything is matched against it (docs/05 §5.1).
      expect(res.status).toBe(422);
      expect(expectError(res).code).toBe('VALIDATION_FAILED');
    });

    it('404s an unknown library', async () => {
      const res = await browse('11111111-1111-4111-8111-111111111111', adminCookie);

      expect(res.status).toBe(404);
    });

    it('refuses an anonymous caller', async () => {
      const libraryId = await givenLibrary();

      const res = await api(app).get(`/api/libraries/${libraryId}/browse`);

      expect(res.status).toBe(401);
    });
  });
});
