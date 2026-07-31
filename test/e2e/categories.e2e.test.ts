import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  categoryDtoSchema,
  listCategoriesResponseSchema,
} from '../../src/shared/contracts/categories';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Categories (docs/07 §7.3, docs/03 §3.3.12, docs/11 §11.12): the managed reference list.
describe('Categories (e2e)', () => {
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
    adminCookie = await onboard(`catadmin${seq}@legere.local`);
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

  const create = (body: Record<string, unknown>) =>
    api(app).post('/api/admin/categories', body).set('Cookie', adminCookie);

  const list = (cookie: string) => api(app).get('/api/categories').set('Cookie', cookie);

  it('creates a category and lists it with a document count', async () => {
    const created = await create({ slug: 'invoice', name: 'Invoice', description: 'Bills.' });

    expect(created.status).toBe(201);
    expect(expectData(created, categoryDtoSchema)).toMatchObject({
      slug: 'invoice',
      name: 'Invoice',
      description: 'Bills.',
      documentCount: 0,
    });

    const page = expectData(await list(adminCookie), listCategoriesResponseSchema);
    expect(page.items.map((item) => item.slug)).toEqual(['invoice']);
  });

  it('refuses a slug that is already taken', async () => {
    await create({ slug: 'invoice', name: 'Invoice' });

    const again = await create({ slug: 'invoice', name: 'Invoices' });

    expect(again.status).toBe(409);
    expect(expectError(again).code).toBe('CATEGORY_SLUG_TAKEN');
  });

  it('refuses a slug that is not kebab-case', async () => {
    const res = await create({ slug: 'Not A Slug', name: 'Nope' });

    expect(res.status).toBe(422);
    expect(expectError(res).code).toBe('VALIDATION_FAILED');
  });

  it('renames a category but never its slug', async () => {
    const category = expectData(
      await create({ slug: 'receipt', name: 'Receipt' }),
      categoryDtoSchema,
    );

    const res = await api(app)
      .patch(`/api/admin/categories/${category.id}`, { name: 'Receipts', slug: 'renamed' })
      .set('Cookie', adminCookie);

    const updated = expectData(res, categoryDtoSchema);
    expect(updated.name).toBe('Receipts');
    // 🔒 The slug is immutable: the classifier answers with it and filters are bookmarked by it.
    expect(updated.slug).toBe('receipt');
  });

  it('counts the documents that carry a category', async () => {
    const category = expectData(
      await create({ slug: 'contract', name: 'Contract' }),
      categoryDtoSchema,
    );
    await givenDocumentWithCategory(category.id);
    await givenDocumentWithCategory(category.id);

    const page = expectData(await list(adminCookie), listCategoriesResponseSchema);

    expect(page.items[0]?.documentCount).toBe(2);
  });

  it('resets the documents to NONE when the category is deleted', async () => {
    const category = expectData(
      await create({ slug: 'medical', name: 'Medical' }),
      categoryDtoSchema,
    );
    const documentId = await givenDocumentWithCategory(category.id, 'MANUAL');

    const res = await api(app)
      .delete(`/api/admin/categories/${category.id}`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
    // Both AUTO and MANUAL go: neither claim is true once the category is gone (docs/03 §3.3.12).
    expect(row.categoryId).toBeNull();
    expect(row.categorySource).toBe('NONE');

    const page = expectData(await list(adminCookie), listCategoriesResponseSchema);
    expect(page.items).toEqual([]);
  });

  it('404s an unknown category on update and delete', async () => {
    const unknown = '11111111-1111-4111-8111-111111111111';

    const patched = await api(app)
      .patch(`/api/admin/categories/${unknown}`, { name: 'x' })
      .set('Cookie', adminCookie);
    const deleted = await api(app)
      .delete(`/api/admin/categories/${unknown}`)
      .set('Cookie', adminCookie);

    expect(patched.status).toBe(404);
    expect(expectError(patched).code).toBe('CATEGORY_NOT_FOUND');
    expect(deleted.status).toBe(404);
  });

  it('lets any signed-in user read the list but only an admin change it', async () => {
    await create({ slug: 'letter', name: 'Letter' });
    const user = await inviteUser(`catuser${seq}@legere.local`);

    const read = expectData(await list(user.cookie), listCategoriesResponseSchema);
    expect(read.items).toHaveLength(1);

    const write = await api(app)
      .post('/api/admin/categories', { slug: 'nope', name: 'Nope' })
      .set('Cookie', user.cookie);
    expect(write.status).toBe(403);
    expect((await api(app).get('/api/categories')).status).toBe(401);
  });

  let contentSeq = 0;

  async function givenDocumentWithCategory(
    categoryId: string,
    source: 'AUTO' | 'MANUAL' = 'AUTO',
  ): Promise<string> {
    contentSeq += 1;
    const document = await testPrisma().document.create({
      data: {
        contentHash: `${contentSeq}`.padStart(64, 'f'),
        source: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 10n,
        title: `Doc ${contentSeq}`,
        categoryId,
        categorySource: source,
      },
    });
    return document.id;
  }
});
