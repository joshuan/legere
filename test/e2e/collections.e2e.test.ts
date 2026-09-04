import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  collectionDetailResponseSchema,
  collectionDtoSchema,
  collectionShareDtoSchema,
  listCollectionSharesResponseSchema,
  listCollectionsResponseSchema,
} from '../../src/shared/contracts/collections';
import { searchResponseSchema } from '../../src/shared/contracts/search';
import {
  userLookupResponseSchema,
  createInviteResponseSchema,
} from '../../src/shared/contracts/users';
import { encodeDocumentCursor } from '../../src/server/infrastructure/persistence/cursor';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument, seedLibrary } from '../helpers/documents';
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
    await testPrisma().$executeRawUnsafe('DELETE FROM pgboss.job');
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

  let contentSeq = 0;

  async function givenLibraryDocument(
    visibility: 'ALL_USERS' | 'RESTRICTED' = 'ALL_USERS',
  ): Promise<{ documentId: string; libraryId: string }> {
    contentSeq += 1;
    const libraryId = await seedLibrary({
      visibility,
      name: `Collections ${contentSeq}`,
      rootPath: `coll-${contentSeq}`,
    });
    const seeded = await seedDocument({
      document: { title: `Library document ${contentSeq}` },
      libraryId,
      files: [{ sizeBytes: 100n }],
    });
    return { documentId: seeded.id, libraryId };
  }

  // A document made of our own bytes: no file of it lies on a volume, so it belongs to whoever made
  // it (docs/03 §3.3.10).
  async function givenDerivedDocument(
    ownerId: string,
    text: { title?: string; markdown?: string } = {},
  ): Promise<string> {
    contentSeq += 1;
    const seeded = await seedDocument({
      document: {
        title: text.title ?? `Uploaded ${contentSeq}`,
        createdById: ownerId,
        ...(text.markdown === undefined ? {} : { markdown: text.markdown }),
      },
      files: [{ sizeBytes: 100n }],
    });
    return seeded.id;
  }

  const asUser = (cookie: string) => ({
    list: () => api(app).get('/api/collections').set('Cookie', cookie),
    create: (body: Record<string, unknown>) =>
      api(app).post('/api/collections', body).set('Cookie', cookie),
    get: (id: string) => api(app).get(`/api/collections/${id}`).set('Cookie', cookie),
    page: (id: string, query: string) =>
      api(app).get(`/api/collections/${id}${query}`).set('Cookie', cookie),
    addItem: (id: string, documentId: string) =>
      api(app).post(`/api/collections/${id}/items`, { documentId }).set('Cookie', cookie),
    share: (id: string, granteeUserId: string | null) =>
      api(app).post(`/api/collections/${id}/shares`, { granteeUserId }).set('Cookie', cookie),
    shares: (id: string) => api(app).get(`/api/collections/${id}/shares`).set('Cookie', cookie),
    revokeShare: (id: string, shareId: string) =>
      api(app).delete(`/api/collections/${id}/shares/${shareId}`).set('Cookie', cookie),
    // The three ways a document is read, all behind the same guard (docs/08 §8.5).
    document: (id: string) => api(app).get(`/api/documents/${id}`).set('Cookie', cookie),
    markdown: (id: string) => api(app).get(`/api/documents/${id}/markdown`).set('Cookie', cookie),
    canonical: (id: string) => api(app).get(`/api/documents/${id}/canonical`).set('Cookie', cookie),
    // Search reaches documents through the other dialect of the same rule (docs/04 §4.3).
    search: (word: string) => api(app).get(`/api/search?q=${word}&mode=text`).set('Cookie', cookie),
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

      // A malformed id reads as "no such collection", not as a driver error (docs/07 §7.1).
      const malformed = await api(app)
        .get('/api/collections/not-a-uuid')
        .set('Cookie', adminCookie);
      expect(malformed.status).toBe(404);
      expect(expectError(malformed).code).toBe('COLLECTION_NOT_FOUND');
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
      // 🔒 SEC-84 / docs/03 §3.3.14: the count is the size of that same intersection. Stating 2
      // beside a list of 1 would say how many documents the grantee was refused, and — polled —
      // when the owner files another one into a library the grantee cannot see.
      expect(detail.collection.itemCount).toBe(1);
      const listed = expectData(
        await asUser(friend.cookie).list(),
        listCollectionsResponseSchema,
      ).items.find((item) => item.id === collection.id);
      expect(listed?.itemCount).toBe(1);
      // The owner is not privileged either: the restricted library is not theirs to read, so their
      // own collection reports what they can list and not what they filed.
      const own = expectData(
        await asUser(owner.cookie).get(collection.id),
        collectionDetailResponseSchema,
      );
      expect(own.collection.itemCount).toBe(1);
      // The admin, who reads everything, is the one who is told there are two.
      const asAdmin = expectData(
        await asUser(adminCookie).get(collection.id),
        collectionDetailResponseSchema,
      );
      expect(asAdmin.collection.itemCount).toBe(2);
    });

    // 🔒 A soft-deleted document is no part of anybody's collection, and the count says so
    // (docs/03 §3.3.14).
    it('stops counting an item whose document has been deleted', async () => {
      const owner = await inviteUser(`counter${seq}@legere.local`);
      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Counted' }),
        collectionDtoSchema,
      );
      const derived = await givenDerivedDocument(owner.id);
      await testPrisma().collectionItem.create({
        data: { collectionId: collection.id, documentId: derived, addedById: owner.id },
      });

      expect(
        expectData(await asUser(owner.cookie).get(collection.id), collectionDetailResponseSchema)
          .collection.itemCount,
      ).toBe(1);

      await testPrisma().document.update({
        where: { id: derived },
        data: { deletedAt: new Date() },
      });

      expect(
        expectData(await asUser(owner.cookie).get(collection.id), collectionDetailResponseSchema)
          .collection.itemCount,
      ).toBe(0);
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

  // 🔒 A share is not a licence to re-share (docs/03 §3.3.15, docs/08 §8.5): what a share carries is
  // the documents in the collection *that its owner created*, and nothing else. It takes three
  // people to see the hole — one who lends, one who re-lends, and one who was lent nothing.
  describe('re-sharing', () => {
    type ReLending = {
      owner: { id: string; cookie: string };
      borrower: { id: string; cookie: string };
      stranger: { id: string; cookie: string };
      documentId: string;
      lent: string;
      relent: string;
      word: string;
    };

    // The owner shares a collection holding a document of their own with the borrower; the borrower
    // puts that document in a collection of their own and shares it with the whole instance.
    async function givenReLentDocument(): Promise<ReLending> {
      const owner = await inviteUser(`lender${seq}@legere.local`);
      const borrower = await inviteUser(`borrower${seq}@legere.local`);
      const stranger = await inviteUser(`stranger${seq}@legere.local`);

      const word = `zeppelin${seq}`;
      const documentId = await givenDerivedDocument(owner.id, {
        title: `Private ${word}`,
        markdown: `The ${word} is nobody else's business.`,
      });

      const lent = expectData(
        await asUser(owner.cookie).create({ name: 'Lent' }),
        collectionDtoSchema,
      ).id;
      expect((await asUser(owner.cookie).addItem(lent, documentId)).status).toBe(201);
      await asUser(owner.cookie).share(lent, borrower.id);

      // The borrower may read it, and may put it in a collection of their own: curating what you can
      // read is what a collection is for (docs/03 §3.3.14).
      expect((await asUser(borrower.cookie).document(documentId)).status).toBe(200);
      const relent = expectData(
        await asUser(borrower.cookie).create({ name: 'Relent' }),
        collectionDtoSchema,
      ).id;
      expect((await asUser(borrower.cookie).addItem(relent, documentId)).status).toBe(201);
      await asUser(borrower.cookie).share(relent, null);

      return { owner, borrower, stranger, documentId, lent, relent, word };
    }

    it('does not carry a borrowed document to a third party through a second collection', async () => {
      const { borrower, stranger, documentId, relent, word } = await givenReLentDocument();

      // 🔒 The instance-wide share carries the collection; the borrowed document stays with the
      // person who created it.
      expect((await asUser(stranger.cookie).document(documentId)).status).toBe(404);
      expect((await asUser(stranger.cookie).canonical(documentId)).status).toBe(404);
      expect((await asUser(stranger.cookie).markdown(documentId)).status).toBe(404);
      const opened = expectData(
        await asUser(stranger.cookie).get(relent),
        collectionDetailResponseSchema,
      );
      expect(opened.items.items).toEqual([]);

      // The rule lives in two dialects and both must hold; search is the other one.
      expect(
        expectData(await asUser(stranger.cookie).search(word), searchResponseSchema).items,
      ).toEqual([]);

      // And what was actually lent still reads and still turns up in search.
      expect((await asUser(borrower.cookie).document(documentId)).status).toBe(200);
      expect(
        expectData(await asUser(borrower.cookie).search(word), searchResponseSchema).items.map(
          (hit) => hit.document.id,
        ),
      ).toEqual([documentId]);
    });

    it('takes the document back when the first share is revoked, with nothing surviving in the second collection', async () => {
      const { owner, borrower, documentId, lent, relent, word } = await givenReLentDocument();

      const shares = expectData(
        await asUser(owner.cookie).shares(lent),
        listCollectionSharesResponseSchema,
      );
      const revoked = await asUser(owner.cookie).revokeShare(lent, shares.items[0]?.id ?? '');
      expect(revoked.status).toBe(200);

      expect((await asUser(borrower.cookie).document(documentId)).status).toBe(404);
      expect((await asUser(borrower.cookie).markdown(documentId)).status).toBe(404);
      expect(
        expectData(await asUser(borrower.cookie).search(word), searchResponseSchema).items,
      ).toEqual([]);

      // 🔒 The item the borrower kept is still in their collection; the access it used to carry is
      // gone with the share that granted it.
      const kept = expectData(
        await asUser(borrower.cookie).get(relent),
        collectionDetailResponseSchema,
      );
      expect(kept.items.items).toEqual([]);
    });

    it('refuses to revoke a share that belongs to another collection', async () => {
      const owner = await inviteUser(`revoker${seq}@legere.local`);
      const friend = await inviteUser(`revokee${seq}@legere.local`);
      const shared = expectData(
        await asUser(owner.cookie).create({ name: 'Shared' }),
        collectionDtoSchema,
      ).id;
      const other = expectData(
        await asUser(owner.cookie).create({ name: 'Other' }),
        collectionDtoSchema,
      ).id;
      const share = expectData(
        await asUser(owner.cookie).share(shared, friend.id),
        collectionShareDtoSchema,
      );

      // The caller owns both collections, so authorization passes — and the write still has to stay
      // inside the collection it was authorized for.
      const wrong = await asUser(owner.cookie).revokeShare(other, share.id);
      expect(wrong.status).toBe(404);
      expect(expectError(wrong).code).toBe('NOT_FOUND');

      const still = expectData(
        await asUser(owner.cookie).shares(shared),
        listCollectionSharesResponseSchema,
      );
      expect(still.items.map((item) => item.id)).toEqual([share.id]);
      expect((await asUser(friend.cookie).get(shared)).status).toBe(200);
    });

    it('applies the access rule to a page that starts at a cursor, not only to the first page', async () => {
      const owner = await inviteUser(`pager${seq}@legere.local`);
      const friend = await inviteUser(`paged${seq}@legere.local`);

      contentSeq += 1;
      const libraryId = await seedLibrary({
        visibility: 'RESTRICTED',
        name: `Paged ${contentSeq}`,
        rootPath: `paged-${contentSeq}`,
      });
      // Older, so it sorts onto the second page; behind a library neither of them may see.
      const hidden = await seedDocument({
        document: { title: 'Behind a library', createdAt: new Date('2026-01-01T00:00:00.000Z') },
        libraryId,
        files: [{ sizeBytes: 100n }],
      });
      const visible = await seedDocument({
        document: {
          title: 'The one they may read',
          createdById: owner.id,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
        },
        files: [{ sizeBytes: 100n }],
      });

      const collection = expectData(
        await asUser(owner.cookie).create({ name: 'Mixed' }),
        collectionDtoSchema,
      ).id;
      await testPrisma().collectionItem.createMany({
        data: [
          { collectionId: collection, documentId: hidden.id, addedById: owner.id },
          { collectionId: collection, documentId: visible.id, addedById: owner.id },
        ],
      });
      await asUser(owner.cookie).share(collection, friend.id);

      const first = expectData(
        await asUser(friend.cookie).page(collection, '?limit=1'),
        collectionDetailResponseSchema,
      );
      expect(first.items.items.map((item) => item.id)).toEqual([visible.id]);

      // 🔒 A cursor is opaque, not secret: anybody can write one. Continuing a page must not switch
      // the access rule off — which is what happens when the rule and the cursor are both an `OR`
      // spread into the same object and the cursor is spread last.
      const cursor = encodeDocumentCursor({
        sort: 'createdAt',
        key: '2026-01-02T00:00:00.000Z',
        id: visible.id,
      });
      const second = expectData(
        await asUser(friend.cookie).page(collection, `?limit=10&cursor=${cursor}`),
        collectionDetailResponseSchema,
      );
      expect(second.items.items).toEqual([]);
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
