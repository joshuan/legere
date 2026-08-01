import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { searchResponseSchema } from '../../src/shared/contracts/search';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Search (docs/07 §7.3, docs/04 §4.3–4.4): words, meaning, and the fusion of the two.
describe('Search (e2e)', () => {
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
    adminCookie = await onboard(`searchadmin${seq}@legere.local`);
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

  async function givenLibrary(visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS'): Promise<string> {
    contentSeq += 1;
    const library = await testPrisma().library.create({
      data: {
        name: `Search ${contentSeq}`,
        rootPath: `search-${contentSeq}`,
        visibility,
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    return library.id;
  }

  // A searchable document: the tsvector is generated from title + markdown by the schema itself.
  async function givenDocument(
    libraryId: string,
    title: string,
    markdown: string | null,
    options: { categoryId?: string; chunk?: number[] } = {},
  ): Promise<string> {
    contentSeq += 1;
    const hash = `${contentSeq}`.padStart(64, '9');
    const document = await testPrisma().document.create({
      data: {
        contentHash: hash,
        source: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 100n,
        title,
        markdown,
        canonicalStatus: 'SKIPPED',
        previewStatus: 'DONE',
        markdownStatus: 'DONE',
        categorizationStatus: 'DONE',
        vectorizationStatus: 'DONE',
        ...(options.categoryId === undefined ? {} : { categoryId: options.categoryId }),
      },
    });
    await testPrisma().fileRef.create({
      data: {
        libraryId,
        documentId: document.id,
        path: `${title.toLowerCase().replace(/\s+/g, '-')}.pdf`,
        size: 100n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: hash,
      },
    });

    if (options.chunk !== undefined) {
      const vector = `[${padded(options.chunk).join(',')}]`;
      await testPrisma().$executeRawUnsafe(
        `INSERT INTO document_chunks (id, document_id, index, content, char_count, embedding)
         VALUES (gen_random_uuid(), $1::uuid, 0, $2, $3, $4::vector)`,
        document.id,
        markdown ?? title,
        (markdown ?? title).length,
        vector,
      );
    }
    return document.id;
  }

  // The column is vector(1536) (docs/04 §4.3); fixtures name only the first components.
  function padded(head: number[]): number[] {
    return Array.from({ length: 1536 }, (_, index) => head[index] ?? 0);
  }

  const search = (cookie: string, query: string) =>
    api(app).get(`/api/search${query}`).set('Cookie', cookie);

  describe('text mode', () => {
    it('finds a document by a word in its body, with the match highlighted', async () => {
      const libraryId = await givenLibrary();
      const documentId = await givenDocument(
        libraryId,
        'Rental agreement',
        'The tenant shall pay the deposit before occupancy.',
      );
      await givenDocument(libraryId, 'Unrelated', 'Nothing about that here.');

      const res = await search(adminCookie, '?q=deposit&mode=text');

      const results = expectData(res, searchResponseSchema);
      expect(results.items.map((hit) => hit.document.id)).toEqual([documentId]);
      // ts_headline marks the words that matched (docs/07 §7.3).
      expect(results.items[0]?.snippet).toContain('<mark>deposit</mark>');
    });

    it('finds a document by its title alone', async () => {
      const libraryId = await givenLibrary();
      const documentId = await givenDocument(libraryId, 'Passport scan', null);

      const res = await search(adminCookie, '?q=passport&mode=text');

      expect(expectData(res, searchResponseSchema).items.map((hit) => hit.document.id)).toEqual([
        documentId,
      ]);
    });

    it('returns nothing for an empty query rather than everything', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(libraryId, 'Something', 'Body');

      const res = await search(adminCookie, '?q=');

      expect(expectData(res, searchResponseSchema).items).toEqual([]);
    });
  });

  describe('access', () => {
    it('never surfaces a document from a library the caller cannot see', async () => {
      const open = await givenLibrary('ALL_USERS');
      const secret = await givenLibrary('RESTRICTED');
      const visible = await givenDocument(open, 'Public invoice', 'The invoice amount is due.');
      await givenDocument(secret, 'Secret invoice', 'The invoice amount is due.');
      const user = await inviteUser(`searchuser${seq}@legere.local`);

      const asUser = expectData(await search(user.cookie, '?q=invoice'), searchResponseSchema);
      const asAdmin = expectData(await search(adminCookie, '?q=invoice'), searchResponseSchema);

      // 🔒 The access rule is inside the query, so the limit applies to readable rows only.
      expect(asUser.items.map((hit) => hit.document.id)).toEqual([visible]);
      expect(asAdmin.items).toHaveLength(2);
    });
  });

  describe('filters', () => {
    it('narrows by library and by category', async () => {
      const one = await givenLibrary();
      const two = await givenLibrary();
      const category = await testPrisma().category.create({
        data: { slug: 'invoice', name: 'Invoice' },
      });
      const inOne = await givenDocument(one, 'Invoice one', 'payment terms apply', {
        categoryId: category.id,
      });
      await givenDocument(two, 'Invoice two', 'payment terms apply');

      const byLibrary = expectData(
        await search(adminCookie, `?q=payment&libraryId=${one}`),
        searchResponseSchema,
      );
      const byCategory = expectData(
        await search(adminCookie, `?q=payment&categoryId=${category.id}`),
        searchResponseSchema,
      );

      expect(byLibrary.items.map((hit) => hit.document.id)).toEqual([inOne]);
      expect(byCategory.items.map((hit) => hit.document.id)).toEqual([inOne]);
    });
  });

  describe('semantic and hybrid', () => {
    it('reports semantic search as unavailable and falls back to text', async () => {
      const libraryId = await givenLibrary();
      const documentId = await givenDocument(libraryId, 'Contract', 'the parties agree');

      const hybrid = expectData(await search(adminCookie, '?q=parties'), searchResponseSchema);
      const semantic = expectData(
        await search(adminCookie, '?q=parties&mode=semantic'),
        searchResponseSchema,
      );

      // No EMBEDDINGS_API_BASE_URL in the test environment (docs/12 §12.4).
      expect(hybrid.semanticAvailable).toBe(false);
      expect(hybrid.items.map((hit) => hit.document.id)).toEqual([documentId]);
      // Asking for semantic explicitly still answers with what the instance can do.
      expect(semantic.items.map((hit) => hit.document.id)).toEqual([documentId]);
    });

    it('orders the same query the same way every time', async () => {
      const libraryId = await givenLibrary();
      await givenDocument(libraryId, 'Invoice A', 'shared word here');
      await givenDocument(libraryId, 'Invoice B', 'shared word here');

      const first = expectData(await search(adminCookie, '?q=shared'), searchResponseSchema);
      const second = expectData(await search(adminCookie, '?q=shared'), searchResponseSchema);

      expect(first.items.map((hit) => hit.document.id)).toEqual(
        second.items.map((hit) => hit.document.id),
      );
    });
  });

  it('refuses an anonymous caller', async () => {
    expect((await api(app).get('/api/search?q=anything')).status).toBe(401);
  });
});
