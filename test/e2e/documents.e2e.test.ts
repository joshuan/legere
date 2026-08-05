import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  documentDetailDtoSchema,
  documentEventPageSchema,
  documentYearsResponseSchema,
  listDocumentsResponseSchema,
} from '../../src/shared/contracts/documents';
import { createInviteResponseSchema, okResponseSchema } from '../../src/shared/contracts/users';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';
import { seedDocument, seedLibrary } from '../helpers/documents';
import { cookieNamed, expectData, expectError } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// The read model and its access rules (docs/07 §7.3, docs/03 §3.4, docs/08 §8.5).
describe('Documents (e2e)', () => {
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
    adminCookie = await onboard(`docadmin${seq}@legere.local`);
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

  // Fixtures are written straight to the database: this suite is about the read model, and the way
  // documents get there is covered by the scan/ingest suites.
  const givenLibrary = (visibility: 'ALL_USERS' | 'RESTRICTED', userIds: string[] = []) =>
    seedLibrary({ visibility, userIds });

  type DocumentOptions = {
    title?: string;
    libraryId?: string;
    refStatus?: 'HASHED' | 'MISSING';
    typeId?: string;
    createdById?: string;
    previewStatus?: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
    markdownStatus?: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED';
    createdAt?: Date;
    sizeBytes?: bigint;
  };

  // A document with one file: a library file when a library is named, our own bytes otherwise
  // (docs/03 §3.3.16).
  async function givenDocument(options: DocumentOptions = {}): Promise<string> {
    const seeded = await seedDocument({
      document: {
        canonicalStatus: 'SKIPPED',
        previewStatus: options.previewStatus ?? 'DONE',
        markdownStatus: options.markdownStatus ?? 'DONE',
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.typeId === undefined ? {} : { typeId: options.typeId, typeSource: 'AUTO' }),
        ...(options.createdById === undefined ? {} : { createdById: options.createdById }),
        ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      },
      ...(options.libraryId === undefined ? {} : { libraryId: options.libraryId }),
      files: [
        {
          sizeBytes: options.sizeBytes ?? 2048n,
          ...(options.refStatus === undefined ? {} : { refStatus: options.refStatus }),
        },
      ],
    });
    return seeded.id;
  }

  const listAs = (cookie: string, query = '') =>
    api(app).get(`/api/documents${query}`).set('Cookie', cookie);

  describe('listing', () => {
    it('returns the documents a user may read, newest first', async () => {
      const open = await givenLibrary('ALL_USERS');
      const older = await givenDocument({
        libraryId: open,
        title: 'Older',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const newer = await givenDocument({
        libraryId: open,
        title: 'Newer',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
      });
      const user = await inviteUser(`reader${seq}@legere.local`);

      const page = expectData(await listAs(user.cookie), listDocumentsResponseSchema);

      expect(page.items.map((item) => item.id)).toEqual([newer, older]);
      expect(page.items[0]).toMatchObject({
        title: 'Newer',
        availability: 'AVAILABLE',
        processing: false,
        hasPreview: true,
        origin: 'LIBRARY',
        fileCount: 1,
        primaryExt: 'pdf',
        // BigInt travels as a string (docs/07 §7.4).
        sizeBytes: '2048',
      });
    });

    it('carries a size past what a JS number holds, exactly (docs/07 §7.4)', async () => {
      const open = await givenLibrary('ALL_USERS');
      // Number.MAX_SAFE_INTEGER + 2: a double cannot hold it, so a numeric DTO would come back
      // rounded down by one. Only a string survives the round trip.
      const documentId = await givenDocument({
        libraryId: open,
        title: 'Huge',
        sizeBytes: 9007199254740993n,
      });
      const user = await inviteUser(`sizes${seq}@legere.local`);

      const page = expectData(await listAs(user.cookie), listDocumentsResponseSchema);

      expect(page.items.find((item) => item.id === documentId)?.sizeBytes).toBe('9007199254740993');
    });

    it('hides a RESTRICTED library from a user without a grant, and shows it once granted', async () => {
      const user = await inviteUser(`outsider${seq}@legere.local`);
      const restricted = await givenLibrary('RESTRICTED');
      const documentId = await givenDocument({ libraryId: restricted, title: 'Private' });

      const before = expectData(await listAs(user.cookie), listDocumentsResponseSchema);
      expect(before.items).toEqual([]);

      await testPrisma().libraryAccess.create({
        data: { libraryId: restricted, userId: user.id },
      });

      const after = expectData(await listAs(user.cookie), listDocumentsResponseSchema);
      expect(after.items.map((item) => item.id)).toEqual([documentId]);
    });

    it('shows an admin everything, including documents in no library at all', async () => {
      const restricted = await givenLibrary('RESTRICTED');
      await givenDocument({ libraryId: restricted });
      // A managed document nobody shared: still an admin's business (docs/08 §8.5).
      await seedDocument({ document: { title: 'Uploaded by nobody' } });

      const page = expectData(await listAs(adminCookie), listDocumentsResponseSchema);

      expect(page.items).toHaveLength(2);
    });

    it('shows a derived document to its creator and to nobody else', async () => {
      const owner = await inviteUser(`owner${seq}@legere.local`);
      const other = await inviteUser(`other${seq}@legere.local`);
      await seedDocument({ document: { title: 'My scan', createdById: owner.id } });

      expect(
        expectData(await listAs(owner.cookie), listDocumentsResponseSchema).items,
      ).toHaveLength(1);
      expect(expectData(await listAs(other.cookie), listDocumentsResponseSchema).items).toEqual([]);
    });

    it('paginates with a cursor, without repeating or dropping a document', async () => {
      const open = await givenLibrary('ALL_USERS');
      for (let index = 0; index < 5; index += 1) {
        await givenDocument({
          libraryId: open,
          title: `Doc ${index}`,
          createdAt: new Date(`2026-0${index + 1}-01T00:00:00.000Z`),
        });
      }

      const first = expectData(await listAs(adminCookie, '?limit=2'), listDocumentsResponseSchema);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();

      const second = expectData(
        await listAs(adminCookie, `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`),
        listDocumentsResponseSchema,
      );
      const third = expectData(
        await listAs(adminCookie, `?limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`),
        listDocumentsResponseSchema,
      );

      const seen = [...first.items, ...second.items, ...third.items].map((item) => item.id);
      expect(new Set(seen).size).toBe(5);
      expect(third.nextCursor).toBeNull();
    });

    describe('filters', () => {
      it('filters by library', async () => {
        const one = await givenLibrary('ALL_USERS');
        const two = await givenLibrary('ALL_USERS');
        const inOne = await givenDocument({ libraryId: one });
        await givenDocument({ libraryId: two });

        const page = expectData(
          await listAs(adminCookie, `?libraryId=${one}`),
          listDocumentsResponseSchema,
        );

        expect(page.items.map((item) => item.id)).toEqual([inOne]);
      });

      it('filters by documentType', async () => {
        const documentType = await testPrisma().documentType.create({
          data: { slug: 'invoice', name: 'Invoice' },
        });
        const open = await givenLibrary('ALL_USERS');
        const categorized = await givenDocument({ libraryId: open, typeId: documentType.id });
        await givenDocument({ libraryId: open });

        const page = expectData(
          await listAs(adminCookie, `?typeId=${documentType.id}`),
          listDocumentsResponseSchema,
        );

        expect(page.items.map((item) => item.id)).toEqual([categorized]);
        expect(page.items[0]?.documentType).toEqual({
          id: documentType.id,
          slug: 'invoice',
          name: 'Invoice',
        });
      });

      it('filters by availability, which follows the files rather than a stored flag', async () => {
        const open = await givenLibrary('ALL_USERS');
        const live = await givenDocument({ libraryId: open });
        const gone = await givenDocument({ libraryId: open, refStatus: 'MISSING' });

        const available = expectData(
          await listAs(adminCookie, '?availability=AVAILABLE'),
          listDocumentsResponseSchema,
        );
        const unavailable = expectData(
          await listAs(adminCookie, '?availability=UNAVAILABLE'),
          listDocumentsResponseSchema,
        );

        expect(available.items.map((item) => item.id)).toEqual([live]);
        expect(unavailable.items.map((item) => item.id)).toEqual([gone]);
        expect(unavailable.items[0]?.availability).toBe('UNAVAILABLE');
      });

      it('filters by whether the pipeline is still working on a document', async () => {
        const open = await givenLibrary('ALL_USERS');
        const done = await givenDocument({ libraryId: open });
        const working = await givenDocument({ libraryId: open, markdownStatus: 'PENDING' });

        const processing = expectData(
          await listAs(adminCookie, '?processing=true'),
          listDocumentsResponseSchema,
        );
        const settled = expectData(
          await listAs(adminCookie, '?processing=false'),
          listDocumentsResponseSchema,
        );

        expect(processing.items.map((item) => item.id)).toEqual([working]);
        expect(settled.items.map((item) => item.id)).toEqual([done]);
      });

      it('filters by origin', async () => {
        const open = await givenLibrary('ALL_USERS');
        const fromLibrary = await givenDocument({ libraryId: open });
        // No file of it lies on a volume, so the document is managed (docs/03 §3.3.10).
        await seedDocument({ document: { title: 'Uploaded' } });

        const page = expectData(
          await listAs(adminCookie, '?origin=LIBRARY'),
          listDocumentsResponseSchema,
        );

        expect(page.items.map((item) => item.id)).toEqual([fromLibrary]);
      });

      it('rejects a filter value that is not part of the contract', async () => {
        const res = await listAs(adminCookie, '?availability=MAYBE');

        expect(res.status).toBe(422);
        expect(expectError(res).code).toBe('VALIDATION_FAILED');
      });
    });
  });

  describe('detail', () => {
    it('returns the full document with the file locations the caller may see', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Contract' });
      const user = await inviteUser(`viewer${seq}@legere.local`);

      const res = await api(app).get(`/api/documents/${documentId}`).set('Cookie', user.cookie);

      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail).toMatchObject({
        id: documentId,
        title: 'Contract',
        typeSource: 'NONE',
        ocrUsed: false,
        createdBy: null,
      });
      expect(detail.steps.markdown).toBe('DONE');
      // What the document is made of, and where those bytes lie (docs/07 §7.3).
      expect(detail.files).toHaveLength(1);
      expect(detail.files[0]).toMatchObject({
        position: 0,
        origin: 'LIBRARY',
        available: true,
        isImage: false,
        crop: null,
        cropSource: 'NONE',
      });
      expect(detail.files[0]?.refs).toHaveLength(1);
      expect(detail.files[0]?.refs[0]).toMatchObject({ libraryId: open, status: 'HASHED' });
    });

    it('hides file locations in libraries the caller cannot see, while an admin sees all of them', async () => {
      const open = await givenLibrary('ALL_USERS');
      const secret = await givenLibrary('RESTRICTED');
      const seeded = await seedDocument({ libraryId: open });
      const documentId = seeded.id;
      // The same bytes also lie in a library this user was never granted: one file, two homes
      // (docs/05 §5.3).
      await testPrisma().fileRef.create({
        data: {
          libraryId: secret,
          fileId: seeded.fileIds[0] ?? '',
          path: 'confidential/copy.pdf',
          size: 2048n,
          mtime: new Date('2026-01-01T00:00:00.000Z'),
          status: 'HASHED',
          contentHash: seeded.contentHashes[0] ?? '',
        },
      });
      const user = await inviteUser(`limited${seq}@legere.local`);

      const asUser = expectData(
        await api(app).get(`/api/documents/${documentId}`).set('Cookie', user.cookie),
        documentDetailDtoSchema,
      );
      const asAdmin = expectData(
        await api(app).get(`/api/documents/${documentId}`).set('Cookie', adminCookie),
        documentDetailDtoSchema,
      );

      // 🔒 A path is a disclosure: the user learns nothing about the library they cannot read.
      expect(asUser.files[0]?.refs.map((ref) => ref.libraryId)).toEqual([open]);
      expect(asAdmin.files[0]?.refs).toHaveLength(2);
    });

    it('404s a document in a library the caller cannot see', async () => {
      const restricted = await givenLibrary('RESTRICTED');
      const documentId = await givenDocument({ libraryId: restricted });
      const user = await inviteUser(`stranger${seq}@legere.local`);

      const res = await api(app).get(`/api/documents/${documentId}`).set('Cookie', user.cookie);

      // 🔒 Not 403: a 403 would confirm that this document exists (docs/08 §8.5).
      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('DOCUMENT_NOT_FOUND');
    });

    it('404s an unknown id and a malformed one alike', async () => {
      const unknown = await api(app)
        .get('/api/documents/11111111-1111-4111-8111-111111111111')
        .set('Cookie', adminCookie);
      expect(unknown.status).toBe(404);

      const malformed = await api(app).get('/api/documents/not-a-uuid').set('Cookie', adminCookie);
      expect(malformed.status).toBe(404);
    });
  });

  describe('editing metadata', () => {
    it('renames a library document, which any reader may do', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Scan 001' });
      const user = await inviteUser(`editor${seq}@legere.local`);

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { title: 'Rental agreement' })
        .set('Cookie', user.cookie);

      expect(expectData(res, documentDetailDtoSchema).title).toBe('Rental agreement');
    });

    it('marks a chosen documentType MANUAL, so the classifier stops overruling it', async () => {
      const documentType = await testPrisma().documentType.create({
        data: { slug: 'contract', name: 'Contract' },
      });
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { typeId: documentType.id })
        .set('Cookie', adminCookie);

      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail.documentType).toMatchObject({ id: documentType.id, slug: 'contract' });
      // 🔒 docs/03 §3.3.10: MANUAL is never overwritten by the pipeline.
      expect(detail.typeSource).toBe('MANUAL');
    });

    it('clearing the documentType records a decision rather than "never classified"', async () => {
      const documentType = await testPrisma().documentType.create({
        data: { slug: 'receipt', name: 'Receipt' },
      });
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, typeId: documentType.id });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { typeId: null })
        .set('Cookie', adminCookie);

      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail.documentType).toBeNull();
      expect(detail.typeSource).toBe('NONE');
    });

    it('refuses a documentType that does not exist', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, {
          typeId: '11111111-1111-4111-8111-111111111111',
        })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(404);
      expect(expectError(res).code).toBe('DOCUMENT_TYPE_NOT_FOUND');
    });

    it('refuses to edit a derived document owned by someone else', async () => {
      const owner = await inviteUser(`derivedowner${seq}@legere.local`);
      const other = await inviteUser(`meddler${seq}@legere.local`);
      const document = await seedDocument({
        document: { title: 'Owner scan', createdById: owner.id },
      });
      // Shared instance-wide, so the other user may read it.
      const collection = await testPrisma().collection.create({
        data: {
          ownerId: owner.id,
          name: 'Shared',
          items: { create: { documentId: document.id, addedById: owner.id } },
          shares: { create: { granteeUserId: null } },
        },
      });
      expect(collection.id).toBeDefined();

      const read = await api(app).get(`/api/documents/${document.id}`).set('Cookie', other.cookie);
      expect(read.status).toBe(200);

      const edit = await api(app)
        .patch(`/api/documents/${document.id}`, { title: 'Not yours' })
        .set('Cookie', other.cookie);

      // 🔒 A share grants reading, not editing (docs/08 §8.5).
      expect(edit.status).toBe(403);
      expect(expectError(edit).code).toBe('FORBIDDEN');
    });

    it('takes the languages and the place a person corrected by hand', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Ticket' });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, {
          languages: ['sr-Latn', 'en'],
          country: 'me',
          city: 'Podgorica',
        })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.languages).toEqual(['sr-Latn', 'en']);
      // Upper-cased on the way in: ISO 3166-1 alpha-2 is written that way, and a stored 'me' would
      // never match a lookup for 'ME'.
      expect(row.country).toBe('ME');
      expect(row.city).toBe('Podgorica');
    });

    it('puts a field back to what the pipeline read, and stops calling it a choice', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Ticket' });
      const documentType = await testPrisma().documentType.create({
        data: { slug: 'ticket', name: 'Ticket' },
      });
      await testPrisma().document.update({
        where: { id: documentId },
        data: {
          city: 'Bar',
          typeId: null,
          typeSource: 'NONE',
          autoValues: { typeSlug: documentType.slug, city: 'Podgorica', country: 'ME' },
        },
      });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { reset: ['city', 'documentType'] })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.city).toBe('Podgorica');
      expect(row.typeId).toBe(documentType.id);
      // 🔒 AUTO, not MANUAL: a reset document stops claiming a person chose this (docs/03 §3.3.10).
      expect(row.typeSource).toBe('AUTO');
    });

    it('marks a title somebody typed as theirs, and gives it back when asked', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'IMG_20260714_113355' });
      await testPrisma().document.update({
        where: { id: documentId },
        data: { title: 'Rental agreement, Njegoševa 12', titleSource: 'AUTO' },
      });

      await api(app)
        .patch(`/api/documents/${documentId}`, { title: 'The flat, everything about it' })
        .set('Cookie', adminCookie);

      const named = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      // 🔒 MANUAL, so no later analysis renames it (docs/03 §3.3.10).
      expect(named.titleSource).toBe('MANUAL');

      await testPrisma().document.update({
        where: { id: documentId },
        data: { autoValues: { title: 'Rental agreement, Njegoševa 12' } },
      });
      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { reset: ['title'] })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const back = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(back.title).toBe('Rental agreement, Njegoševa 12');
      // And back to AUTO: the document stops claiming a person chose this.
      expect(back.titleSource).toBe('AUTO');
    });

    it('tells an admin which host a step ran against, and tells nobody else', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Ticket' });
      await testPrisma().documentEvent.create({
        data: {
          documentId,
          type: 'STEP_FINISHED',
          payload: {
            step: 'markdown',
            status: 'DONE',
            service: 'docling',
            endpoint: 'http://docling:5001',
            requestId: '11111111-1111-4111-8111-111111111111',
          },
        },
      });

      const asAdmin = await api(app)
        .get(`/api/documents/${documentId}/events`)
        .set('Cookie', adminCookie);
      const [adminEntry] = expectData(asAdmin, documentEventPageSchema).items;
      expect(adminEntry?.payload.endpoint).toBe('http://docling:5001');

      const reader = await inviteUser(`logreader${seq}@legere.local`);
      const asUser = await api(app)
        .get(`/api/documents/${documentId}/events`)
        .set('Cookie', reader.cookie);
      const [userEntry] = expectData(asUser, documentEventPageSchema).items;
      // 🔒 A host on an internal network is operational detail, and only an admin can act on it
      // (docs/03 §3.3.18). The service and the id still travel: they say who did the work.
      expect(userEntry?.payload.endpoint).toBeUndefined();
      expect(userEntry?.payload.service).toBe('docling');
      expect(userEntry?.payload.requestId).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('writes what a person changed into the document log', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Ticket' });

      await api(app)
        .patch(`/api/documents/${documentId}`, { city: 'Bar', title: 'Train ticket' })
        .set('Cookie', adminCookie);

      const res = await api(app)
        .get(`/api/documents/${documentId}/events`)
        .set('Cookie', adminCookie);

      const [entry] = expectData(res, documentEventPageSchema).items;
      expect(entry?.type).toBe('META_CHANGED');
      // Who, and what it was before — the point of a log is the "before" (docs/03 §3.3.18).
      expect(entry?.actor).not.toBeNull();
      expect(entry?.payload.changes).toMatchObject({
        title: { from: 'Ticket', to: 'Train ticket' },
        city: { to: 'Bar' },
      });
    });

    it('finds a document by who and what it is about, and by the year it carries', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Lease' });
      const person = await testPrisma().person.create({ data: { name: 'Marija Petrović' } });
      const subjectKind = await testPrisma().subjectKind.create({ data: { name: 'apartment' } });
      const subject = await testPrisma().subject.create({
        data: { kindId: subjectKind.id, name: 'Njegoševa 5' },
      });

      await api(app)
        .patch(`/api/documents/${documentId}`, {
          peopleIds: [person.id],
          subjectIds: [subject.id],
          documentDate: '2019-03-01',
        })
        .set('Cookie', adminCookie);

      for (const query of [`personId=${person.id}`, `subjectId=${subject.id}`, 'year=2019']) {
        const res = await api(app).get(`/api/documents?${query}`).set('Cookie', adminCookie);
        const page = expectData(res, listDocumentsResponseSchema);
        expect(page.items.map((item) => item.id)).toEqual([documentId]);
      }

      // The years a shelf actually has, newest first — the folders of a cabinet by date.
      const years = await api(app).get('/api/documents/years').set('Cookie', adminCookie);
      expect(expectData(years, documentYearsResponseSchema).items).toContainEqual({
        year: 2019,
        count: 1,
      });
    });

    it('rejects an empty patch', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, {})
        .set('Cookie', adminCookie);

      expect(res.status).toBe(422);
    });
  });

  describe('deletion', () => {
    it('soft-deletes a document, after which it is gone from every route', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });

      const deleted = await api(app)
        .delete(`/api/documents/${documentId}`)
        .set('Cookie', adminCookie);
      expect(expectData(deleted, okResponseSchema)).toEqual({ ok: true });

      const detail = await api(app).get(`/api/documents/${documentId}`).set('Cookie', adminCookie);
      expect(detail.status).toBe(404);
      const page = expectData(await listAs(adminCookie), listDocumentsResponseSchema);
      expect(page.items).toEqual([]);

      // ADR-015: the row is still there, just no longer part of the product.
      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('refuses deletion to a non-admin', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });
      const user = await inviteUser(`nondeleter${seq}@legere.local`);

      const res = await api(app).delete(`/api/documents/${documentId}`).set('Cookie', user.cookie);

      expect(res.status).toBe(403);
    });

    it('404s a second delete', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });
      await api(app).delete(`/api/documents/${documentId}`).set('Cookie', adminCookie);

      const again = await api(app)
        .delete(`/api/documents/${documentId}`)
        .set('Cookie', adminCookie);

      expect(again.status).toBe(404);
    });
  });

  it('refuses every document route to an anonymous caller', async () => {
    const open = await givenLibrary('ALL_USERS');
    const documentId = await givenDocument({ libraryId: open });

    expect((await api(app).get('/api/documents')).status).toBe(401);
    expect((await api(app).get(`/api/documents/${documentId}`)).status).toBe(401);
    expect((await api(app).patch(`/api/documents/${documentId}`, { title: 'x' })).status).toBe(401);
  });
});
