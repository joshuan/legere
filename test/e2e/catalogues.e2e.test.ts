import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import { listPeopleResponseSchema, personDtoSchema } from '../../src/shared/contracts/people';
import {
  listSubjectKindsResponseSchema,
  subjectKindDtoSchema,
} from '../../src/shared/contracts/subject-kinds';
import { listSubjectsResponseSchema, subjectDtoSchema } from '../../src/shared/contracts/subjects';
import { createInviteResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// The catalogues a document is filed by (docs/03 §3.3.19–20a, docs/07 §7.3): people, the things
// documents are about, and what sort of thing each of those is. Adding is open to anyone signed in,
// because the analysis adds on its own; correcting and removing are an admin's.
describe('Catalogues (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let userCookie: string;
  let seq = 0;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await truncateAll();
    await testPrisma().$executeRawUnsafe('TRUNCATE TABLE pgboss.job');
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`catalogueadmin${seq}@legere.local`);
    userCookie = (await inviteUser(`cataloguereader${seq}@legere.local`)).cookie;
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

  const givenKind = async (name: string, cookie = adminCookie): Promise<string> =>
    expectData(
      await api(app).post('/api/subject-kinds', { name }).set('Cookie', cookie),
      subjectKindDtoSchema,
    ).id;

  describe('subject kinds', () => {
    it('lets anyone signed in add one, lower-cased and only once', async () => {
      // Open on purpose: whoever files a boat must not wait for an admin to invent "boat"
      // (docs/03 §3.3.20a).
      const created = await api(app)
        .post('/api/subject-kinds', { name: 'Apartment' })
        .set('Cookie', userCookie);

      expect(created.status).toBe(201);
      expect(expectData(created, subjectKindDtoSchema).name).toBe('apartment');

      // 🔒 One row per living name: "Apartment" and "apartment" are one kind.
      const again = await api(app)
        .post('/api/subject-kinds', { name: 'apartment' })
        .set('Cookie', adminCookie);
      expect(again.status).toBe(409);
      expect(expectError(again).code).toBe('SUBJECT_KIND_EXISTS');
    });

    it('counts what hangs off a kind, which is what it is worth keeping for', async () => {
      const kindId = await givenKind('apartment');
      const subject = await api(app)
        .post('/api/subjects', { kindId, name: 'Njegoševa 5' })
        .set('Cookie', userCookie);
      const subjectId = expectData(subject, subjectDtoSchema).id;

      const document = await testPrisma().document.create({
        data: {
          contentHash: 'd'.repeat(64),
          source: 'UPLOAD',
          mimeType: 'application/pdf',
          ext: 'pdf',
          sizeBytes: 10n,
          title: 'Lease',
        },
      });
      await testPrisma().documentSubject.create({
        data: { documentId: document.id, subjectId },
      });

      const [kind] = expectData(
        await api(app).get('/api/subject-kinds').set('Cookie', userCookie),
        listSubjectKindsResponseSchema,
      ).items;
      expect(kind).toMatchObject({ name: 'apartment', subjectCount: 1, documentCount: 1 });
    });

    it('renames a kind once for everything filed under it, and only for an admin', async () => {
      const kindId = await givenKind('flat');
      await api(app)
        .post('/api/subjects', { kindId, name: 'Njegoševa 5' })
        .set('Cookie', adminCookie);

      const refused = await api(app)
        .patch(`/api/admin/subject-kinds/${kindId}`, { name: 'apartment' })
        .set('Cookie', userCookie);
      expect(refused.status).toBe(403);
      expect(expectError(refused).code).toBe('FORBIDDEN');

      const renamed = await api(app)
        .patch(`/api/admin/subject-kinds/${kindId}`, { name: 'apartment' })
        .set('Cookie', adminCookie);
      expect(renamed.status).toBe(200);

      // One edit, and every thing filed under it reads the new name — the point of a catalogue.
      const [subject] = expectData(
        await api(app).get('/api/subjects').set('Cookie', userCookie),
        listSubjectsResponseSchema,
      ).items;
      expect(subject).toMatchObject({ kind: 'apartment', name: 'Njegoševa 5' });
    });

    it('refuses to remove a kind that still holds something', async () => {
      const kindId = await givenKind('car');
      const subject = await api(app)
        .post('/api/subjects', { kindId, name: 'Golf IV' })
        .set('Cookie', adminCookie);

      // 🔒 A subject with no kind is not a thing anybody can file by, so the subjects go first
      // (docs/03 §3.3.20a).
      const failedSubjectKindInUse = await api(app)
        .delete(`/api/admin/subject-kinds/${kindId}`)
        .set('Cookie', adminCookie);
      expect(failedSubjectKindInUse.status).toBe(409);
      expect(expectError(failedSubjectKindInUse).code).toBe('SUBJECT_KIND_IN_USE');

      await api(app)
        .delete(`/api/admin/subjects/${expectData(subject, subjectDtoSchema).id}`)
        .set('Cookie', adminCookie);
      const removed = await api(app)
        .delete(`/api/admin/subject-kinds/${kindId}`)
        .set('Cookie', adminCookie);
      expect(removed.status).toBe(200);
      expect(
        expectData(
          await api(app).get('/api/subject-kinds').set('Cookie', adminCookie),
          listSubjectKindsResponseSchema,
        ).items,
      ).toEqual([]);
    });
  });

  describe('subjects', () => {
    it('refuses a kind that is not in the catalogue rather than inventing one', async () => {
      const failedSubjectKindNotFound = await api(app)
        .post('/api/subjects', {
          kindId: '11111111-1111-4111-8111-111111111111',
          name: 'Njegoševa 5',
        })
        .set('Cookie', userCookie);
      expect(failedSubjectKindNotFound.status).toBe(404);
      expect(expectError(failedSubjectKindNotFound).code).toBe('SUBJECT_KIND_NOT_FOUND');
    });

    it('keeps two things of different kinds that share a name', async () => {
      const country = await givenKind('country');
      const boat = await givenKind('boat');

      const first = await api(app)
        .post('/api/subjects', { kindId: country, name: 'Montenegro' })
        .set('Cookie', adminCookie);
      const second = await api(app)
        .post('/api/subjects', { kindId: boat, name: 'Montenegro' })
        .set('Cookie', adminCookie);

      expect(first.status).toBe(201);
      // The kind is part of the identity: the country and the boat are two things (docs/04 §4.3).
      expect(second.status).toBe(201);

      const third = await api(app)
        .post('/api/subjects', { kindId: boat, name: 'montenegro' })
        .set('Cookie', adminCookie);
      expect(third.status).toBe(409);
      expect(expectError(third).code).toBe('SUBJECT_EXISTS');
    });

    it('moves a thing to another kind, which is an ordinary correction', async () => {
      const country = await givenKind('country');
      const boat = await givenKind('boat');
      const subjectId = expectData(
        await api(app)
          .post('/api/subjects', { kindId: country, name: 'Montenegro' })
          .set('Cookie', adminCookie),
        subjectDtoSchema,
      ).id;

      const moved = await api(app)
        .patch(`/api/admin/subjects/${subjectId}`, { kindId: boat })
        .set('Cookie', adminCookie);

      expect(expectData(moved, subjectDtoSchema)).toMatchObject({ kind: 'boat', kindId: boat });
    });
  });

  describe('people', () => {
    it('is added by anyone, renamed by an admin, and never twice under one name', async () => {
      const created = await api(app)
        .post('/api/people', { name: 'Marija Petrović' })
        .set('Cookie', userCookie);
      expect(created.status).toBe(201);
      const personId = expectData(created, personDtoSchema).id;

      const failedPersonExists = await api(app)
        .post('/api/people', { name: 'marija petrović' })
        .set('Cookie', userCookie);
      expect(failedPersonExists.status).toBe(409);
      expect(expectError(failedPersonExists).code).toBe('PERSON_EXISTS');
      const failedForbidden = await api(app)
        .patch(`/api/admin/people/${personId}`, { name: 'Marija Petrovic' })
        .set('Cookie', userCookie);
      expect(failedForbidden.status).toBe(403);
      expect(expectError(failedForbidden).code).toBe('FORBIDDEN');

      const renamed = await api(app)
        .patch(`/api/admin/people/${personId}`, { name: 'Marija Petrovic' })
        .set('Cookie', adminCookie);
      expect(expectData(renamed, personDtoSchema).name).toBe('Marija Petrovic');

      await api(app).delete(`/api/admin/people/${personId}`).set('Cookie', adminCookie);
      expect(
        expectData(
          await api(app).get('/api/people').set('Cookie', userCookie),
          listPeopleResponseSchema,
        ).items,
      ).toEqual([]);
    });
  });
});
