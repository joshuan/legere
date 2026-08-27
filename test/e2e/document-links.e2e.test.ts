import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  documentEventPageSchema,
  documentLinkDtoSchema,
  documentLinkSuggestionsResponseSchema,
  documentLinksResponseSchema,
} from '../../src/shared/contracts/documents';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument, seedLibrary } from '../helpers/documents';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// The edges between documents (docs/03 §3.3.23, docs/07 §7.3): undirected, person-made, visible
// only where both ends are — and suggested, never created, by the archive itself (docs/05 §5.6b).
describe('Document links (e2e)', () => {
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
    adminCookie = await onboard(`linkadmin${seq}@legere.local`);
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

  async function givenDocument(libraryId: string, title: string, markdown = ''): Promise<string> {
    const seeded = await seedDocument({
      libraryId,
      document: { title, markdown: markdown === '' ? null : markdown },
    });
    return seeded.id;
  }

  const linksOf = async (id: string, cookie = adminCookie) =>
    expectData(
      await api(app).get(`/api/documents/${id}/links`).set('Cookie', cookie),
      documentLinksResponseSchema,
    );

  describe('the edge itself', () => {
    it('creates one edge both ends list, and removes it from either end', async () => {
      const library = await seedLibrary({ visibility: 'ALL_USERS' });
      const contract = await givenDocument(library, 'Contract № 12-2019');
      const act = await givenDocument(library, 'Act of acceptance');

      const created = await api(app)
        .post(`/api/documents/${contract}/links`, { documentId: act })
        .set('Cookie', adminCookie);
      expect(created.status).toBe(201);
      expect(expectData(created, documentLinkDtoSchema).document.id).toBe(act);

      // Undirected: both ends list the same edge (docs/03 §3.3.23).
      expect((await linksOf(contract)).items.map((item) => item.document.id)).toEqual([act]);
      expect((await linksOf(act)).items.map((item) => item.document.id)).toEqual([contract]);

      // And the journal of both says so, as a record carrying the other's title.
      const log = expectData(
        await api(app).get(`/api/documents/${act}/events`).set('Cookie', adminCookie),
        documentEventPageSchema,
      );
      const linked = log.items.find((entry) => entry.type === 'LINKED');
      expect(linked?.payload.otherDocumentId).toBe(contract);
      expect(linked?.payload.otherTitle).toBe('Contract № 12-2019');

      // Removed from the other end than it was made from: an edge belongs to both.
      const removed = await api(app)
        .delete(`/api/documents/${act}/links/${contract}`)
        .set('Cookie', adminCookie);
      expect(removed.status).toBe(200);
      expect((await linksOf(contract)).items).toEqual([]);
    });

    it('refuses a duplicate in either spelling, and a document linked to itself', async () => {
      const library = await seedLibrary({ visibility: 'ALL_USERS' });
      const a = await givenDocument(library, 'A');
      const b = await givenDocument(library, 'B');
      await api(app)
        .post(`/api/documents/${a}/links`, { documentId: b })
        .set('Cookie', adminCookie);

      // The same edge from the other end is the same edge (docs/03 §3.3.23).
      const duplicate = await api(app)
        .post(`/api/documents/${b}/links`, { documentId: a })
        .set('Cookie', adminCookie);
      expect(duplicate.status).toBe(409);
      expect(expectError(duplicate).code).toBe('LINK_EXISTS');

      const self = await api(app)
        .post(`/api/documents/${a}/links`, { documentId: a })
        .set('Cookie', adminCookie);
      expect(self.status).toBe(422);
      expect(expectError(self).code).toBe('LINK_SELF');
    });

    it('answers LINK_NOT_FOUND for an unlink with no edge behind it', async () => {
      const library = await seedLibrary({ visibility: 'ALL_USERS' });
      const a = await givenDocument(library, 'A');
      const b = await givenDocument(library, 'B');

      const removed = await api(app)
        .delete(`/api/documents/${a}/links/${b}`)
        .set('Cookie', adminCookie);
      expect(removed.status).toBe(404);
      expect(expectError(removed).code).toBe('LINK_NOT_FOUND');
    });

    it('takes the edges of a hard-deleted document with it', async () => {
      const library = await seedLibrary({ visibility: 'ALL_USERS' });
      const a = await givenDocument(library, 'A');
      const b = await givenDocument(library, 'B');
      await api(app)
        .post(`/api/documents/${a}/links`, { documentId: b })
        .set('Cookie', adminCookie);

      await api(app).delete(`/api/documents/${b}`).set('Cookie', adminCookie);

      expect((await linksOf(a)).items).toEqual([]);
      expect(await testPrisma().documentLink.count()).toBe(0);
    });
  });

  describe('access (docs/03 §3.4)', () => {
    it('hides an edge whose other side the caller may not read — absent, not redacted', async () => {
      const open = await seedLibrary({ visibility: 'ALL_USERS' });
      const restricted = await seedLibrary({ visibility: 'RESTRICTED' });
      const visible = await givenDocument(open, 'Visible');
      const hidden = await givenDocument(restricted, 'Hidden');
      await api(app)
        .post(`/api/documents/${visible}/links`, { documentId: hidden })
        .set('Cookie', adminCookie);

      const reader = await inviteUser(`linkreader${seq}@legere.local`);
      expect((await linksOf(visible, reader.cookie)).items).toEqual([]);
      // The admin still sees the whole of it.
      expect((await linksOf(visible)).items.map((item) => item.document.id)).toEqual([hidden]);
    });

    // 🔒 SEC-63 / docs/03 §3.3.18: the journal of the visible end used to print the hidden end's
    // title and uuid, which is exactly what the links list above refuses to say.
    it('does not name the other end in the journal either, where the reader may not read it', async () => {
      const open = await seedLibrary({ visibility: 'ALL_USERS' });
      const restricted = await seedLibrary({ visibility: 'RESTRICTED' });
      const visible = await givenDocument(open, 'Visible');
      const hidden = await givenDocument(restricted, 'Passport — Ivan Petrov 4510 123456');
      await api(app)
        .post(`/api/documents/${visible}/links`, { documentId: hidden })
        .set('Cookie', adminCookie);

      const reader = await inviteUser(`journalreader${seq}@legere.local`);
      const events = await api(app)
        .get(`/api/documents/${visible}/events`)
        .set('Cookie', reader.cookie);
      expect(events.status).toBe(200);
      const linked = expectData(events, documentEventPageSchema).items.filter(
        (item) => item.type === 'LINKED',
      );
      expect(linked).toHaveLength(1);
      expect(linked[0]?.payload.otherTitle).toBeUndefined();
      expect(linked[0]?.payload.otherDocumentId).toBeUndefined();

      // The admin still reads the whole entry — the record is not destroyed, only withheld.
      const forAdmin = expectData(
        await api(app).get(`/api/documents/${visible}/events`).set('Cookie', adminCookie),
        documentEventPageSchema,
      ).items.filter((item) => item.type === 'LINKED');
      expect(forAdmin[0]?.payload.otherDocumentId).toBe(hidden);
      expect(forAdmin[0]?.payload.otherTitle).toBe('Passport — Ivan Petrov 4510 123456');
    });

    it('requires read access on the other end to link at all', async () => {
      const open = await seedLibrary({ visibility: 'ALL_USERS' });
      const restricted = await seedLibrary({ visibility: 'RESTRICTED' });
      const visible = await givenDocument(open, 'Visible');
      const hidden = await givenDocument(restricted, 'Hidden');

      const reader = await inviteUser(`linkwriter${seq}@legere.local`);
      const refused = await api(app)
        .post(`/api/documents/${visible}/links`, { documentId: hidden })
        .set('Cookie', reader.cookie);
      // 🔒 That it exists at all is none of the caller's business (docs/08 §8.5).
      expect(refused.status).toBe(404);
      expect(expectError(refused).code).toBe('DOCUMENT_NOT_FOUND');
    });
  });

  describe('suggestions (docs/05 §5.6b)', () => {
    it('proposes the documents that cite this one, saying which identifiers matched', async () => {
      const library = await seedLibrary({ visibility: 'ALL_USERS' });
      const contract = await givenDocument(
        library,
        'Contract № 12-2019',
        'Lease agreement 12-2019 for the flat on Njegoševa 12.',
      );
      const act = await givenDocument(
        library,
        'Act of acceptance',
        'Work delivered under agreement 12-2019 in full.',
      );
      const unrelated = await givenDocument(library, 'Manual', 'How to descale the machine.');

      const res = await api(app)
        .get(`/api/documents/${contract}/link-suggestions`)
        .set('Cookie', adminCookie);
      const suggestions = expectData(res, documentLinkSuggestionsResponseSchema);

      const ids = suggestions.items.map((item) => item.document.id);
      expect(ids).toContain(act);
      expect(ids).not.toContain(unrelated);
      // 🔒 Never itself: a document always cites its own numbers.
      expect(ids).not.toContain(contract);
      const match = suggestions.items.find((item) => item.document.id === act);
      expect(match?.matchedTokens).toContain('12-2019');
    });

    it('excludes what is already linked, and stores nothing about a refusal', async () => {
      const library = await seedLibrary({ visibility: 'ALL_USERS' });
      const contract = await givenDocument(library, 'Contract 77-2020', 'Agreement 77-2020.');
      const act = await givenDocument(library, 'Act', 'Under agreement 77-2020.');
      await api(app)
        .post(`/api/documents/${contract}/links`, { documentId: act })
        .set('Cookie', adminCookie);

      const res = await api(app)
        .get(`/api/documents/${contract}/link-suggestions`)
        .set('Cookie', adminCookie);
      expect(
        expectData(res, documentLinkSuggestionsResponseSchema).items.map(
          (item) => item.document.id,
        ),
      ).not.toContain(act);
      // Deterministic and stateless: the same question answers the same, and no table grew.
      const again = await api(app)
        .get(`/api/documents/${contract}/link-suggestions`)
        .set('Cookie', adminCookie);
      expect(expectData(again, documentLinkSuggestionsResponseSchema)).toEqual(
        expectData(res, documentLinkSuggestionsResponseSchema),
      );
    });

    it('answers under the access rule: a candidate the caller may not read is no candidate', async () => {
      const open = await seedLibrary({ visibility: 'ALL_USERS' });
      const restricted = await seedLibrary({ visibility: 'RESTRICTED' });
      const contract = await givenDocument(open, 'Contract 88-2021', 'Agreement 88-2021.');
      await givenDocument(restricted, 'Hidden act', 'Under agreement 88-2021.');

      const reader = await inviteUser(`suggestreader${seq}@legere.local`);
      const res = await api(app)
        .get(`/api/documents/${contract}/link-suggestions`)
        .set('Cookie', reader.cookie);
      expect(expectData(res, documentLinkSuggestionsResponseSchema).items).toEqual([]);
    });
  });
});
