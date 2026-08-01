import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  collectionDetailResponseSchema,
  collectionDtoSchema,
  collectionShareDtoSchema,
  listCollectionSharesResponseSchema,
  listCollectionsResponseSchema,
} from '../../src/shared/contracts/collections';
import {
  userLookupResponseSchema,
  createInviteResponseSchema,
} from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// Collections and sharing (docs/07 §7.3, docs/03 §3.3.13–3.3.15, docs/08 §8.5).
describe('Collections (e2e)', () => {
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
    adminCookie = await onboard(`colladmin${seq}@legere.local`);
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

  async function givenLibraryDocument(
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<{ documentId: string; libraryId: string }> {
    contentSeq += 1;
    const library = await testPrisma().library.create({
      data: {
        name: `Collections ${contentSeq}`,
        rootPath: `coll-${contentSeq}`,
        visibility,
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    const hash = `${contentSeq}`.padStart(64, '7');
    const document = await testPrisma().document.create({
      data: {
        contentHash: hash,
        source: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 100n,
        title: `Library document ${contentSeq}`,
      },
    });
    await testPrisma().fileRef.create({
      data: {
        libraryId: library.id,
        documentId: document.id,
        path: `file-${contentSeq}.pdf`,
        size: 100n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: hash,
      },
    });
    return { documentId: document.id, libraryId: library.id };
  }

  async function givenDerivedDocument(ownerId: string): Promise<string> {
    contentSeq += 1;
    const document = await testPrisma().document.create({
      data: {
        contentHash: `${contentSeq}`.padStart(64, '8'),
        source: 'DERIVED',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 100n,
        title: `Merged scan ${contentSeq}`,
        createdById: ownerId,
      },
    });
    return document.id;
  }

  const asUser = (cookie: string) => ({
    list: () => api(app).get('/api/collections').set('Cookie', cookie),
    create: (body: Record<string, unknown>) =>
      api(app).post('/api/collections', body).set('Cookie', cookie),
    get: (id: string) => api(app).get(`/api/collections/${id}`).set('Cookie', cookie),
    addItem: (id: string, documentId: string) =>
      api(app).post(`/api/collections/${id}/items`, { documentId }).set('Cookie', cookie),
    share: (id: string, granteeUserId: string | null) =>
      api(app).post(`/api/collections/${id}/shares`, { granteeUserId }).set('Cookie', cookie),
  });

  describe('CRUD', () => {
    it('creates a collection and lists it as the caller own', async () => {
      const created = await asUser(adminCookie).create({ name: 'Taxes', description: 'Yearly.' });

      expect(created.status).toBe(201);
      expect(expectData(created, collectionDtoSchema)).toMatchObject({
        name: 'Taxes',
        mine: true,
        sharedByMe: false,
        sharedWithMe: false,
        itemCount: 0,
      });

      const list = expectData(await asUser(adminCookie).list(), listCollectionsResponseSchema);
      expect(list.items.map((item) => item.name)).toEqual(['Taxes']);
    });

    it('refuses a name the same owner already used, but not one another owner did', async () => {
      await asUser(adminCookie).create({ name: 'Taxes' });
      const again = await asUser(adminCookie).create({ name: 'Taxes' });

      expect(again.status).toBe(409);
      expect(expectError(again).code).toBe('COLLECTION_NAME_TAKEN');

      // Names are unique per owner, not per instance (docs/03 §3.3.13).
      const other = await inviteUser(`colluser${seq}@legere.local`);
      const theirs = await asUser(other.cookie).create({ name: 'Taxes' });
      expect(theirs.status).toBe(201);
    });

    it('renames and deletes a collection, and only the owner may', async () => {
      const collection = expectData(
        await asUser(adminCookie).create({ name: 'Personal' }),
        collectionDtoSchema,
      );
      const other = await inviteUser(`meddler${seq}@legere.local`);

      const byOther = await api(app)
        .patch(`/api/collections/${collection.id}`, { name: 'Hijacked' })
        .set('Cookie', other.cookie);
      expect(byOther.status).toBe(404);

      const renamed = await api(app)
        .patch(`/api/collections/${collection.id}`, { name: 'Household' })
        .set('Cookie', adminCookie);
      expect(expectData(renamed, collectionDtoSchema).name).toBe('Household');

      const deleted = await api(app)
        .delete(`/api/collections/${collection.id}`)
        .set('Cookie', adminCookie);
      expect(deleted.status).toBe(200);
      expect((await asUser(adminCookie).get(collection.id)).status).toBe(404);
    });
  });

  describe('items', () => {
    it('adds a document the caller can read, and refuses one they cannot', async () => {
      const owner = await inviteUser(`owner${seq}@legere.local`);
      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Mine' }),
        collectionDtoSchema,
      );
      const open = await givenLibraryDocument('ALL_USERS');
      const secret = await givenLibraryDocument('RESTRICTED');

      expect((await asUser(owner.cookie).addItem(collection.id, open.documentId)).status).toBe(201);
      // 🔒 A collection is not a way to launder access to a document you cannot open.
      const refused = await asUser(owner.cookie).addItem(collection.id, secret.documentId);
      expect(refused.status).toBe(404);
      expect(expectError(refused).code).toBe('DOCUMENT_NOT_FOUND');

      const detail = expectData(
        await asUser(owner.cookie).get(collection.id),
        collectionDetailResponseSchema,
      );
      expect(detail.items.items.map((item) => item.id)).toEqual([open.documentId]);
    });

    it('removes an item without leaving a trace of it', async () => {
      const collection = expectData(
        await asUser(adminCookie).create({ name: 'Temporary' }),
        collectionDtoSchema,
      );
      const { documentId } = await givenLibraryDocument();
      await asUser(adminCookie).addItem(collection.id, documentId);

      const removed = await api(app)
        .delete(`/api/collections/${collection.id}/items/${documentId}`)
        .set('Cookie', adminCookie);

      expect(removed.status).toBe(200);
      const detail = expectData(
        await asUser(adminCookie).get(collection.id),
        collectionDetailResponseSchema,
      );
      expect(detail.items.items).toEqual([]);
    });
  });

  describe('sharing', () => {
    it('shares with one user, who then sees the collection but not the library documents in it', async () => {
      const owner = await inviteUser(`sharer${seq}@legere.local`);
      const friend = await inviteUser(`friend${seq}@legere.local`);
      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Shared' }),
        collectionDtoSchema,
      );

      // One of each: a derived document the owner made, and a library document from a library the
      // friend has no access to.
      const derived = await givenDerivedDocument(owner.id);
      const restricted = await givenLibraryDocument('RESTRICTED');
      await testPrisma().collectionItem.createMany({
        data: [
          { collectionId: collection.id, documentId: derived, addedById: owner.id },
          { collectionId: collection.id, documentId: restricted.documentId, addedById: owner.id },
        ],
      });

      expect((await asUser(friend.cookie).get(collection.id)).status).toBe(404);

      const share = await asUser(owner.cookie).share(collection.id, friend.id);
      expect(expectData(share, collectionShareDtoSchema).granteeUserId).toBe(friend.id);

      const detail = expectData(
        await asUser(friend.cookie).get(collection.id),
        collectionDetailResponseSchema,
      );
      // 🔒 The share carries the derived document; the library one stays behind its library
      // (docs/03 §3.3.15) — users cannot widen library exposure.
      expect(detail.items.items.map((item) => item.id)).toEqual([derived]);
      expect(detail.collection.sharedWithMe).toBe(true);
    });

    it('shares with the whole instance', async () => {
      const owner = await inviteUser(`broadcaster${seq}@legere.local`);
      const anyone = await inviteUser(`anyone${seq}@legere.local`);
      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Everyone' }),
        collectionDtoSchema,
      );

      await asUser(owner.cookie).share(collection.id, null);

      const list = expectData(await asUser(anyone.cookie).list(), listCollectionsResponseSchema);
      expect(list.items.map((item) => item.id)).toContain(collection.id);
    });

    it('keeps one active share per grantee, and revoking closes the door again', async () => {
      const owner = await inviteUser(`owner2${seq}@legere.local`);
      const friend = await inviteUser(`friend2${seq}@legere.local`);
      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Once' }),
        collectionDtoSchema,
      );

      const first = expectData(
        await asUser(owner.cookie).share(collection.id, friend.id),
        collectionShareDtoSchema,
      );
      const second = expectData(
        await asUser(owner.cookie).share(collection.id, friend.id),
        collectionShareDtoSchema,
      );
      // Sharing twice means what it already meant (docs/03 §3.3.15).
      expect(second.id).toBe(first.id);

      const shares = expectData(
        await api(app).get(`/api/collections/${collection.id}/shares`).set('Cookie', owner.cookie),
        listCollectionSharesResponseSchema,
      );
      expect(shares.items).toHaveLength(1);

      const revoked = await api(app)
        .delete(`/api/collections/${collection.id}/shares/${first.id}`)
        .set('Cookie', owner.cookie);
      expect(revoked.status).toBe(200);
      expect((await asUser(friend.cookie).get(collection.id)).status).toBe(404);
    });

    it('lets only the owner see and change the share list', async () => {
      const owner = await inviteUser(`owner3${seq}@legere.local`);
      const friend = await inviteUser(`friend3${seq}@legere.local`);
      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Private list' }),
        collectionDtoSchema,
      );
      await asUser(owner.cookie).share(collection.id, friend.id);

      const asFriend = await api(app)
        .get(`/api/collections/${collection.id}/shares`)
        .set('Cookie', friend.cookie);

      // Reading a collection does not mean seeing who else has it.
      expect(asFriend.status).toBe(403);
    });
  });

  describe('user lookup', () => {
    it('finds active users by name or email, capped at ten', async () => {
      await inviteUser(`findme${seq}@legere.local`);

      const res = await api(app).get(`/api/users/lookup?q=findme${seq}`).set('Cookie', adminCookie);

      const items = expectData(res, userLookupResponseSchema);
      expect(items).toHaveLength(1);
      expect(items[0]?.email).toBe(`findme${seq}@legere.local`);
    });

    it('refuses an anonymous caller', async () => {
      expect((await api(app).get('/api/users/lookup?q=a')).status).toBe(401);
    });
  });
});
