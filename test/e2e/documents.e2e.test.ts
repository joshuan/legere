import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema, userDtoSchema } from '../../src/shared/contracts/auth';
import {
  documentDetailDtoSchema,
  documentEventPageSchema,
  documentGroupsResponseSchema,
  documentYearsResponseSchema,
  listDocumentsResponseSchema,
} from '../../src/shared/contracts/documents';
import { searchResponseSchema } from '../../src/shared/contracts/search';
import { createInviteResponseSchema, okResponseSchema } from '../../src/shared/contracts/users';
import { encodeDocumentCursor } from '../../src/server/infrastructure/persistence/cursor';
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

      // Neither carries a date of its own, so this asks for the order that has one to compare
      // (docs/07 §7.1) — by name, even though it is also the default, so the assertion is about the
      // order rather than about which order is the default.
      const page = expectData(
        await listAs(user.cookie, '?sort=createdAt'),
        listDocumentsResponseSchema,
      );

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

    // The three named orders of docs/07 §7.1, and the cursor that names which one it was cut from.
    describe('order', () => {
      // Every page of a list, walked one row at a time, so the keyset predicate is exercised at
      // every boundary rather than only at the first one.
      async function walk(cookie: string, sort: string): Promise<string[]> {
        const ids: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const query: string =
            cursor === null
              ? `?sort=${sort}&limit=1`
              : `?sort=${sort}&limit=1&cursor=${encodeURIComponent(cursor)}`;
          const answer = expectData(await listAs(cookie, query), listDocumentsResponseSchema);
          ids.push(...answer.items.map((item) => item.id));
          cursor = answer.nextCursor;
          if (cursor === null) break;
        }
        return ids;
      }

      it('arranges the shelf by the date on the paper, with the undated ahead of everything', async () => {
        const open = await givenLibrary('ALL_USERS');
        const old = await seedDocument({
          document: { title: 'Old', documentDate: new Date('2019-01-01T00:00:00.000Z') },
          libraryId: open,
        });
        const recent = await seedDocument({
          document: { title: 'Recent', documentDate: new Date('2024-05-05T00:00:00.000Z') },
          libraryId: open,
        });
        // No date read off it yet: inside this order the one still wanting attention, put first
        // rather than buried behind a century of dated ones (docs/07 §7.1).
        const undated = await seedDocument({ document: { title: 'Undated' }, libraryId: open });

        // Asked for by name, because this is no longer what the list answers when nobody says
        // (docs/07 §7.3).
        const page = expectData(
          await listAs(adminCookie, '?sort=documentDate'),
          listDocumentsResponseSchema,
        );

        expect(page.items.map((item) => item.id)).toEqual([undated.id, recent.id, old.id]);
        expect(await walk(adminCookie, 'documentDate')).toEqual([undated.id, recent.id, old.id]);
      });

      it('opens on what arrived last when nobody names an order', async () => {
        const open = await givenLibrary('ALL_USERS');
        // The date on the paper and the date it arrived disagree on purpose: a receipt from 2019
        // scanned this morning is the newest thing in the archive and the oldest thing on the shelf,
        // and what somebody arriving asks is what came in since they were last here (docs/07 §7.3).
        const filedFirst = await seedDocument({
          document: {
            title: 'Filed first',
            documentDate: new Date('2024-05-05T00:00:00.000Z'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          libraryId: open,
        });
        const filedSecond = await seedDocument({
          document: { title: 'Filed second', createdAt: new Date('2026-02-01T00:00:00.000Z') },
          libraryId: open,
        });
        const filedLast = await seedDocument({
          document: {
            title: 'Filed last',
            documentDate: new Date('2019-01-01T00:00:00.000Z'),
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
          },
          libraryId: open,
        });

        const page = expectData(await listAs(adminCookie), listDocumentsResponseSchema);

        expect(page.items.map((item) => item.id)).toEqual([
          filedLast.id,
          filedSecond.id,
          filedFirst.id,
        ]);
        // The default is a named order like any other, so asking for it by name is the same answer —
        // and the cursor walks it the same way.
        expect(await walk(adminCookie, 'createdAt')).toEqual([
          filedLast.id,
          filedSecond.id,
          filedFirst.id,
        ]);
      });

      it('walks the undated block and the dated one as a single order, one page at a time', async () => {
        const open = await givenLibrary('ALL_USERS');
        const undated = [
          await seedDocument({ document: { title: 'U1' }, libraryId: open }),
          await seedDocument({ document: { title: 'U2' }, libraryId: open }),
        ];
        const dated = [
          await seedDocument({
            document: { title: 'D1', documentDate: new Date('2024-05-05T00:00:00.000Z') },
            libraryId: open,
          }),
          await seedDocument({
            document: { title: 'D2', documentDate: new Date('2019-01-01T00:00:00.000Z') },
            libraryId: open,
          }),
        ];

        const walked = await walk(adminCookie, 'documentDate');

        // Nothing repeated, nothing dropped, and the boundary between the two blocks crossed once.
        expect(new Set(walked).size).toBe(4);
        expect(walked.slice(0, 2).sort()).toEqual(undated.map((seeded) => seeded.id).sort());
        expect(walked.slice(2)).toEqual([dated[0]?.id, dated[1]?.id]);
      });

      it('arranges the shelf by the newest entry in the document journal, whatever wrote it', async () => {
        const open = await givenLibrary('ALL_USERS');
        const first = await givenDocument({ libraryId: open, title: 'Filed first' });
        const second = await givenDocument({ libraryId: open, title: 'Filed second' });

        // Neither has been touched, so both read as the moment they came into being.
        expect(
          expectData(await listAs(adminCookie, '?sort=lastEventAt'), listDocumentsResponseSchema)
            .items[0]?.id,
        ).toBe(second);

        // An edit writes a META_CHANGED entry through the one method every event goes through
        // (docs/03 §3.3.18), and the column beside the log moves with it.
        const renamed = await api(app)
          .patch(`/api/documents/${first}`, { title: 'Corrected' })
          .set('Cookie', adminCookie);
        expect(renamed.status).toBe(200);

        expect(await walk(adminCookie, 'lastEventAt')).toEqual([first, second]);
        // And the other two orders are unmoved by it: an edit is not a re-filing.
        expect(await walk(adminCookie, 'createdAt')).toEqual([second, first]);
      });

      it('refuses a cursor cut from another order rather than answering off the wrong column', async () => {
        const open = await givenLibrary('ALL_USERS');
        await givenDocument({ libraryId: open, title: 'One' });
        await givenDocument({ libraryId: open, title: 'Two' });

        const byArrival = expectData(
          await listAs(adminCookie, '?sort=createdAt&limit=1'),
          listDocumentsResponseSchema,
        );
        expect(byArrival.nextCursor).not.toBeNull();
        const cursor = encodeURIComponent(byArrival.nextCursor ?? '');

        // 🔒 A cursor is opaque, not secret, and a keyset predicate read off the wrong column does
        // not fail — it answers, skipping and repeating rows (docs/07 §7.1).
        const crossed = await listAs(adminCookie, `?sort=documentDate&limit=1&cursor=${cursor}`);
        expect(crossed.status).toBe(422);
        expect(expectError(crossed).code).toBe('CURSOR_SORT_MISMATCH');

        // The same cursor, asked the question it was cut from, still works.
        const continued = expectData(
          await listAs(adminCookie, `?sort=createdAt&limit=1&cursor=${cursor}`),
          listDocumentsResponseSchema,
        );
        expect(continued.items).toHaveLength(1);
      });

      it('rejects an order that is not one of the named ones', async () => {
        const refused = await listAs(adminCookie, '?sort=title');

        expect(refused.status).toBe(422);
        expect(expectError(refused).code).toBe('VALIDATION_FAILED');
      });

      it('applies the access rule to a second page in every order, not only to the first', async () => {
        const user = await inviteUser(`pager${seq}@legere.local`);
        const restricted = await givenLibrary('RESTRICTED');
        // Older in all three orders, so it lands on page two of every one of them — and behind a
        // library this reader was never granted.
        await seedDocument({
          document: {
            title: 'Behind a library',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            lastEventAt: new Date('2026-01-01T00:00:00.000Z'),
            documentDate: new Date('2019-01-01T00:00:00.000Z'),
          },
          libraryId: restricted,
        });
        const visible = await seedDocument({
          document: {
            title: 'The one they may read',
            createdById: user.id,
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
            lastEventAt: new Date('2026-01-02T00:00:00.000Z'),
            documentDate: new Date('2020-01-01T00:00:00.000Z'),
          },
        });

        // The last row of page one, in each order's own spelling of "here is where I stopped".
        const pages = [
          { sort: 'documentDate', key: '2020-01-01' },
          { sort: 'createdAt', key: '2026-01-02T00:00:00.000Z' },
          { sort: 'lastEventAt', key: '2026-01-02T00:00:00.000Z' },
        ] as const;

        for (const { sort, key } of pages) {
          const first = expectData(
            await listAs(user.cookie, `?sort=${sort}&limit=1`),
            listDocumentsResponseSchema,
          );
          expect(first.items.map((item) => item.id)).toEqual([visible.id]);

          // 🔒 Anybody can write a cursor. Continuing a page must not switch the access rule off —
          // which is what happens when the rule and the cursor are both an `OR` spread into one
          // object and the cursor is spread last.
          const forged = encodeDocumentCursor({ sort, key, id: visible.id });
          const second = expectData(
            await listAs(
              user.cookie,
              `?sort=${sort}&limit=10&cursor=${encodeURIComponent(forged)}`,
            ),
            listDocumentsResponseSchema,
          );
          expect(second.items).toEqual([]);
        }
      });
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

    // What a card may show besides its title, on every row of every page (docs/07 §7.3).
    it('carries the date, the names, the place and the languages of every row', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Lease' });
      const person = await testPrisma().person.create({ data: { name: 'Marija Petrović' } });
      const kind = await testPrisma().subjectKind.create({ data: { name: 'apartment' } });
      const subject = await testPrisma().subject.create({
        data: { kindId: kind.id, name: 'Njegoševa 5' },
      });
      await api(app)
        .patch(`/api/documents/${documentId}`, {
          peopleIds: [person.id],
          subjectIds: [subject.id],
          documentDate: '2019-03-01',
          country: 'me',
          city: 'Podgorica',
          languages: ['sr', 'en'],
        })
        .set('Cookie', adminCookie);

      const [item] = expectData(await listAs(adminCookie), listDocumentsResponseSchema).items;

      // Sent whatever the screen draws: which of them a card shows is the reader's choice, and it
      // lives in their URL rather than in this request (docs/11 §11.3).
      expect(item?.documentDate).toBe('2019-03-01');
      expect(item?.people).toEqual([{ id: person.id, name: 'Marija Petrović' }]);
      expect(item?.subjects).toEqual([{ id: subject.id, name: 'Njegoševa 5' }]);
      expect(item?.country).toBe('ME');
      expect(item?.city).toBe('Podgorica');
      expect(item?.languages).toEqual(['sr', 'en']);
    });
  });

  // Real shelves with real counts, under the filters in force (docs/07 §7.3).
  describe('grouping', () => {
    const groupsAs = (cookie: string, query: string) =>
      api(app).get(`/api/documents/groups?${query}`).set('Cookie', cookie);

    const nameOn = async (documentId: string, personIds: string[]) => {
      await api(app)
        .patch(`/api/documents/${documentId}`, { peopleIds: personIds })
        .set('Cookie', adminCookie);
    };

    it('answers a shelf per value, biggest first, with its key and its label', async () => {
      const open = await givenLibrary('ALL_USERS');
      const lease = await givenDocument({ libraryId: open, title: 'Lease' });
      const letter = await givenDocument({ libraryId: open, title: 'Letter' });
      const ana = await testPrisma().person.create({ data: { name: 'Ana Petrović' } });
      const marko = await testPrisma().person.create({ data: { name: 'Marko Marković' } });
      await nameOn(lease, [ana.id, marko.id]);
      await nameOn(letter, [marko.id]);

      const answer = expectData(
        await groupsAs(adminCookie, 'by=person'),
        documentGroupsResponseSchema,
      );

      // A document about two people is on both shelves — the alternative is a card that vanishes
      // from a shelf it belongs on — and the fullest shelf comes first.
      expect(answer.items).toEqual([
        { key: marko.id, label: 'Marko Marković', count: 2 },
        { key: ana.id, label: 'Ana Petrović', count: 1 },
      ]);

      // A group's contents are the ordinary list filtered by that group's key, which is what makes
      // the shelf reachable at all (docs/07 §7.3).
      const contents = expectData(
        await listAs(adminCookie, `?personId=${ana.id}`),
        listDocumentsResponseSchema,
      );
      expect(contents.items.map((item) => item.id)).toEqual([lease]);
    });

    it('counts the archive under the filters in force, not the page on screen', async () => {
      const open = await givenLibrary('ALL_USERS');
      const other = await givenLibrary('ALL_USERS');
      const ana = await testPrisma().person.create({ data: { name: 'Ana Petrović' } });
      for (const libraryId of [open, open, other]) {
        await nameOn(await givenDocument({ libraryId, title: 'Paper' }), [ana.id]);
      }

      // A page of one on the screen, and a shelf that says three: the number is the archive's
      // under the filters, not a header drawn over what this page happened to hold (docs/07 §7.3).
      const page = expectData(await listAs(adminCookie, '?limit=1'), listDocumentsResponseSchema);
      expect(page.items).toHaveLength(1);
      const whole = expectData(
        await groupsAs(adminCookie, 'by=person'),
        documentGroupsResponseSchema,
      );
      expect(whole.items).toEqual([{ key: ana.id, label: 'Ana Petrović', count: 3 }]);

      const narrowed = expectData(
        await groupsAs(adminCookie, `by=person&libraryId=${other}`),
        documentGroupsResponseSchema,
      );
      expect(narrowed.items).toEqual([{ key: ana.id, label: 'Ana Petrović', count: 1 }]);
    });

    it('counts only the documents the caller may read', async () => {
      const user = await inviteUser(`grouper${seq}@legere.local`);
      const open = await givenLibrary('ALL_USERS');
      const restricted = await givenLibrary('RESTRICTED');
      const ana = await testPrisma().person.create({ data: { name: 'Ana Petrović' } });
      const marko = await testPrisma().person.create({ data: { name: 'Marko Marković' } });
      await nameOn(await givenDocument({ libraryId: open, title: 'Open' }), [ana.id]);
      await nameOn(await givenDocument({ libraryId: restricted, title: 'Behind a library' }), [
        ana.id,
        marko.id,
      ]);

      const asUser = expectData(
        await groupsAs(user.cookie, 'by=person'),
        documentGroupsResponseSchema,
      );

      // 🔒 A count over documents this reader may not open would be a leak dressed as a number, and
      // a shelf they can reach nothing through is not a shelf that exists for them (docs/03 §3.4).
      expect(asUser.items).toEqual([{ key: ana.id, label: 'Ana Petrović', count: 1 }]);
      expect(
        expectData(await groupsAs(adminCookie, 'by=person'), documentGroupsResponseSchema).items,
      ).toEqual([
        { key: ana.id, label: 'Ana Petrović', count: 2 },
        { key: marko.id, label: 'Marko Marković', count: 1 },
      ]);
    });

    it('groups by the year on the paper and by the type of the document', async () => {
      const open = await givenLibrary('ALL_USERS');
      const type = await testPrisma().documentType.create({
        data: { slug: 'lease', name: 'Lease' },
      });
      const dated = await givenDocument({ libraryId: open, typeId: type.id, title: 'Dated' });
      await api(app)
        .patch(`/api/documents/${dated}`, { documentDate: '2019-03-01' })
        .set('Cookie', adminCookie);
      // Neither dated nor typed: not on a shelf of either dimension, but in the group of everything
      // the dimension cannot place — which comes last and is reachable by `unassigned=`
      // (docs/07 §7.3, docs/11 §11.3).
      await givenDocument({ libraryId: open, title: 'Unread' });

      expect(
        expectData(await groupsAs(adminCookie, 'by=year'), documentGroupsResponseSchema).items,
      ).toEqual([
        { key: '2019', label: '2019', count: 1 },
        { key: null, label: '', count: 1 },
      ]);
      expect(
        expectData(await groupsAs(adminCookie, 'by=type'), documentGroupsResponseSchema).items,
      ).toEqual([
        { key: type.id, label: 'Lease', count: 1 },
        { key: null, label: '', count: 1 },
      ]);

      // And that group's contents are the ordinary list, asked for what the dimension cannot place.
      const unplaced = expectData(
        await api(app).get('/api/documents?unassigned=year').set('Cookie', adminCookie),
        listDocumentsResponseSchema,
      );
      expect(unplaced.items.map((item) => item.title)).toEqual(['Unread']);
    });

    it('refuses a dimension that is not one of the offered ones', async () => {
      // `libraryId` filters, but a document holds many files in one library, so a count over it
      // would count joins rather than documents (docs/07 §7.3).
      for (const query of ['by=library', 'by=subjectKind', 'by=processing', '']) {
        const refused = await groupsAs(adminCookie, query);
        expect(refused.status).toBe(422);
        expect(expectError(refused).code).toBe('VALIDATION_FAILED');
      }
    });

    it('refuses half a step filter here too, because half a filter is a wrong number', async () => {
      const refused = await groupsAs(adminCookie, 'by=person&step=preview');

      expect(refused.status).toBe(422);
      expect(expectError(refused).code).toBe('VALIDATION_FAILED');
    });

    it('refuses the whole endpoint to an anonymous caller', async () => {
      const refused = await api(app).get('/api/documents/groups?by=person');

      expect(refused.status).toBe(401);
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

    // A location is answered for every file, not only for the ones lying on a volume: `refs` is
    // empty for a managed file, which left an upload with no whereabouts at all (docs/09 §9.2).
    it('answers where the bytes are for an upload as well as for a file on a volume', async () => {
      const open = await givenLibrary('ALL_USERS');
      const onVolume = await seedDocument({ libraryId: open });
      // No library: an upload, or something Legere made (docs/03 §3.3.16).
      const uploaded = await seedDocument({ files: [{ ext: 'jpg', mimeType: 'image/jpeg' }] });
      const fileId = uploaded.fileIds[0] ?? '';

      const managed = expectData(
        await api(app).get(`/api/documents/${uploaded.id}`).set('Cookie', adminCookie),
        documentDetailDtoSchema,
      );
      // The object storage, and the key the bytes are under — the layout of docs/09 §9.2, taken from
      // the row rather than guessed, so a key written by an older version keeps resolving.
      expect(managed.files[0]?.refs).toEqual([]);
      expect(managed.files[0]?.storageKey).toBe(`files/${fileId}/original.jpg`);

      // A library file has no object at all: its bytes stay on the volume, and its `refs` say where.
      const library = expectData(
        await api(app).get(`/api/documents/${onVolume.id}`).set('Cookie', adminCookie),
        documentDetailDtoSchema,
      );
      expect(library.files[0]?.storageKey).toBeNull();
      expect(library.files[0]?.refs).toHaveLength(1);
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

    it('edits a typed field, marks it MANUAL, and makes it findable (docs/03 §3.3.10a)', async () => {
      const receipt = await testPrisma().documentType.create({
        data: { slug: 'receipt', name: 'Receipt' },
      });
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({
        libraryId: open,
        title: 'Scan 042',
        typeId: receipt.id,
      });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, {
          fields: { vendor: 'Voli Market', total: { amount: 12.4, currency: 'EUR' } },
        })
        .set('Cookie', adminCookie);

      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail.extracted).toEqual({
        schema: { slug: 'receipt', version: 2 },
        values: { vendor: 'Voli Market', total: { amount: 12.4, currency: 'EUR' } },
        sources: { vendor: 'MANUAL', total: 'MANUAL' },
      });

      // The FTS projection lands with the answer, and the generated vector picks it up: the vendor
      // is findable even though no prose of the document says it (docs/04 §4.3).
      const found = await api(app).get('/api/search?q=Voli&mode=text').set('Cookie', adminCookie);
      expect(
        expectData(found, searchResponseSchema).items.map((item) => item.document.id),
      ).toContain(documentId);
    });

    it('puts a typed field back to what the model read, as AUTO (docs/07 §7.3)', async () => {
      const receipt = await testPrisma().documentType.create({
        data: { slug: 'receipt', name: 'Receipt' },
      });
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, typeId: receipt.id });
      await testPrisma().document.update({
        where: { id: documentId },
        data: {
          extracted: {
            schema: { slug: 'receipt', version: 1 },
            values: { vendor: 'Corrected by hand' },
            sources: { vendor: 'MANUAL' },
          },
          autoValues: { fields: { vendor: 'Voli' } },
        },
      });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { reset: ['fields.vendor'] })
        .set('Cookie', adminCookie);

      const detail = expectData(res, documentDetailDtoSchema);
      expect(detail.extracted?.values).toEqual({ vendor: 'Voli' });
      // 🔒 Back to AUTO: a value put back stops claiming a person chose it (docs/03 §3.3.10a).
      expect(detail.extracted?.sources).toEqual({ vendor: 'AUTO' });
    });

    it('refuses a field the schema does not know, and a document whose type has none', async () => {
      const receipt = await testPrisma().documentType.create({
        data: { slug: 'receipt', name: 'Receipt' },
      });
      const open = await givenLibrary('ALL_USERS');
      const typed = await givenDocument({ libraryId: open, typeId: receipt.id });
      const unknown = await api(app)
        .patch(`/api/documents/${typed}`, { fields: { invented: 'x' } })
        .set('Cookie', adminCookie);
      expect(unknown.status).toBe(422);
      expect(expectError(unknown).code).toBe('VALIDATION_FAILED');

      const untyped = await givenDocument({ libraryId: open });
      const schemaless = await api(app)
        .patch(`/api/documents/${untyped}`, { fields: { vendor: 'Voli' } })
        .set('Cookie', adminCookie);
      expect(schemaless.status).toBe(422);
      expect(expectError(schemaless).code).toBe('VALIDATION_FAILED');
    });

    it('a type changed by hand re-queues the fields step and clears the stale reading', async () => {
      const receipt = await testPrisma().documentType.create({
        data: { slug: 'receipt', name: 'Receipt' },
      });
      const contract = await testPrisma().documentType.create({
        data: { slug: 'contract', name: 'Contract' },
      });
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, typeId: receipt.id });
      await testPrisma().document.update({
        where: { id: documentId },
        data: {
          extracted: {
            schema: { slug: 'receipt', version: 1 },
            values: { vendor: 'Voli' },
            sources: { vendor: 'MANUAL' },
          },
          extractedSearchText: 'Voli',
        },
      });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { typeId: contract.id })
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);

      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      // 🔒 The reading belonged to the type (docs/05 §5.5 step 5): gone now, not after a run that
      // may never replace it — and the step is queued to read again under the new schema.
      expect(row.extracted).toBeNull();
      expect(row.extractedSearchText).toBeNull();
      expect(row.fieldsStatus).toBe('QUEUED');
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
            durationMs: 4200,
            chars: 665,
            ocrUsed: true,
          },
        },
      });

      const asAdmin = await api(app)
        .get(`/api/documents/${documentId}/events`)
        .set('Cookie', adminCookie);
      const [adminEntry] = expectData(asAdmin, documentEventPageSchema).items;
      expect(adminEntry?.payload.endpoint).toBe('http://docling:5001');
      // What the step cost survives the trip back out (docs/03 §3.3.18): the read-side schema used
      // to strip these, so the log answered "how long did this take" with silence.
      expect(adminEntry?.payload.durationMs).toBe(4200);
      expect(adminEntry?.payload.chars).toBe(665);
      expect(adminEntry?.payload.ocrUsed).toBe(true);

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

    it('names no folder in the log that the same reader is refused in the file list', async () => {
      const open = await givenLibrary('ALL_USERS');
      const secret = await givenLibrary('RESTRICTED');
      const seeded = await seedDocument({ libraryId: open });
      const documentId = seeded.id;
      const openPath = seeded.paths[0] ?? '';
      const secretPath = 'hr/terminations/notice.pdf';
      // The same bytes seen a second time, inside a library this reader was never granted: one
      // file, two homes (docs/05 §5.3). The ref is what `GET /api/documents/:id` filters away.
      await testPrisma().fileRef.create({
        data: {
          libraryId: secret,
          fileId: seeded.fileIds[0] ?? '',
          path: secretPath,
          size: 2048n,
          mtime: new Date('2026-01-01T00:00:00.000Z'),
          status: 'HASHED',
          contentHash: seeded.contentHashes[0] ?? '',
        },
      });
      // ...and this is what the ingest wrote about both sightings (docs/03 §3.3.18).
      await testPrisma().documentEvent.createMany({
        data: [
          { documentId, type: 'CREATED', payload: { source: 'LIBRARY', path: openPath } },
          { documentId, type: 'FILE_ATTACHED', payload: { source: 'LIBRARY', path: secretPath } },
        ],
      });
      const user = await inviteUser(`logwalls${seq}@legere.local`);

      // The two answers the same viewer gets: where the files lie, and what the log says about it.
      async function pathsSeenBy(
        cookie: string,
      ): Promise<{ refs: string[]; log: string[]; entries: number }> {
        const detail = expectData(
          await api(app).get(`/api/documents/${documentId}`).set('Cookie', cookie),
          documentDetailDtoSchema,
        );
        const page = expectData(
          await api(app).get(`/api/documents/${documentId}/events`).set('Cookie', cookie),
          documentEventPageSchema,
        );
        return {
          refs: detail.files.flatMap((file) => file.refs.map((ref) => ref.path)),
          log: page.items.flatMap((event) =>
            event.payload.path === undefined ? [] : [event.payload.path],
          ),
          entries: page.items.length,
        };
      }

      const asReader = await pathsSeenBy(user.cookie);
      const asAdmin = await pathsSeenBy(adminCookie);

      // 🔒 The log and the file list agree: neither names a folder the other withholds, so reading
      // a document whose bytes also lie elsewhere teaches nothing about elsewhere (SEC-13).
      expect(asReader.log.every((path) => asReader.refs.includes(path))).toBe(true);
      expect(asReader.refs).not.toContain(secretPath);
      expect(asReader.log).not.toContain(secretPath);
      // The entries themselves stay: the reader still learns that a second copy turned up, which is
      // the provenance the log exists for (docs/03 §3.3.18). Only the folder is withheld.
      expect(asReader.entries).toBe(2);
      // The same agreement holds for an admin, who may see both libraries: nothing is stripped from
      // either answer, and the folders match.
      expect(asAdmin.log.every((path) => asAdmin.refs.includes(path))).toBe(true);
      expect(asAdmin.log).toContain(secretPath);
      expect(asAdmin.log).toContain(openPath);
    });

    it('still names the file in an entry about bytes this instance holds itself', async () => {
      const owner = await inviteUser(`uploader${seq}@legere.local`);
      const documentId = await givenDocument({ title: 'Scan', createdById: owner.id });
      await testPrisma().documentEvent.create({
        data: {
          documentId,
          type: 'FILE_ATTACHED',
          actorId: owner.id,
          payload: { source: 'UPLOAD', path: 'page two.pdf' },
        },
      });

      const page = expectData(
        await api(app).get(`/api/documents/${documentId}/events`).set('Cookie', owner.cookie),
        documentEventPageSchema,
      );

      // Only a library path is somebody else's folder (docs/03 §3.3.18): an upload names a file the
      // reader is already looking at, and the log would be poorer for hiding it.
      expect(page.items[0]?.payload.path).toBe('page two.pdf');
    });

    // 🔒 The page format is an instruction the next build reads (docs/07 §7.3): it has to be written,
    // and it has to be all that happens. Both halves were wrong — the column was never updated, so
    // the answer came back as the `AUTO` still stored, and a rebuild of the canonical, the preview and
    // the text was enqueued anyway on the strength of a change that had not been saved.
    it('stores a chosen page format, and rebuilds nothing on its own', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open, title: 'Lease' });

      const res = await api(app)
        .patch(`/api/documents/${documentId}`, { pageFormat: 'A4' })
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      // What the caller is told is what the column holds: a form that reads its answer back must not
      // be shown the value it just replaced.
      expect(expectData(res, documentDetailDtoSchema).pageFormat).toBe('A4');
      const row = await testPrisma().document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row.pageFormat).toBe('A4');

      // Nothing was queued, and no step was reset: the pages take the new shape the next time they
      // are built, which is asked for with `POST /api/documents/:id/reprocess`.
      expect(row.previewStatus).toBe('DONE');
      expect(row.markdownStatus).toBe('DONE');
      const jobs = await testPrisma().$queryRawUnsafe<Array<{ count: bigint }>>(
        "SELECT count(*) AS count FROM pgboss.job WHERE name = 'document-process'",
      );
      expect(jobs[0]?.count).toBe(0n);

      // The change is still traceable — it is the field most worth tracing (docs/03 §3.3.18).
      const events = await api(app)
        .get(`/api/documents/${documentId}/events`)
        .set('Cookie', adminCookie);
      const [entry] = expectData(events, documentEventPageSchema).items;
      expect(entry?.type).toBe('META_CHANGED');
      expect(entry?.payload.changes).toMatchObject({ pageFormat: { from: 'AUTO', to: 'A4' } });
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

    // 🔒 03 §3.3.19: a deleted name stays on the documents that already name it, and no new document
    // may take it. The second half was a promise nothing kept — the ids went straight to the link
    // table.
    it('keeps a deleted name on the document, and refuses to put it on another', async () => {
      const open = await givenLibrary('ALL_USERS');
      const named = await givenDocument({ libraryId: open, title: 'Named' });
      const other = await givenDocument({ libraryId: open, title: 'Other' });
      const person = await testPrisma().person.create({ data: { name: 'Petar Petrović' } });

      await api(app)
        .patch(`/api/documents/${named}`, { peopleIds: [person.id] })
        .set('Cookie', adminCookie);
      await api(app).delete(`/api/admin/people/${person.id}`).set('Cookie', adminCookie);

      // Still there, and now saying it is only a record.
      const detail = await api(app).get(`/api/documents/${named}`).set('Cookie', adminCookie);
      expect(expectData(detail, documentDetailDtoSchema).people).toEqual([
        { id: person.id, name: 'Petar Petrović', deleted: true },
      ]);

      // And it cannot be given to anything else.
      const refused = await api(app)
        .patch(`/api/documents/${other}`, { peopleIds: [person.id] })
        .set('Cookie', adminCookie);
      expect(refused.status).toBe(404);
      expect(expectError(refused).code).toBe('PERSON_NOT_FOUND');
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

    // The three filters the viewer's details pane needed and did not have (docs/07 §7.3): the kind
    // of thing a document is about, and where it is from.
    it('finds a document by the kind of thing it is about, and by where it is from', async () => {
      const open = await givenLibrary('ALL_USERS');
      const lease = await givenDocument({ libraryId: open, title: 'Lease' });
      const other = await givenDocument({ libraryId: open, title: 'Service book' });
      const flats = await testPrisma().subjectKind.create({ data: { name: 'apartment' } });
      const cars = await testPrisma().subjectKind.create({ data: { name: 'car' } });
      const flat = await testPrisma().subject.create({
        data: { kindId: flats.id, name: 'Njegoševa 5' },
      });
      const car = await testPrisma().subject.create({
        data: { kindId: cars.id, name: 'Zastava 750' },
      });

      await api(app)
        .patch(`/api/documents/${lease}`, {
          subjectIds: [flat.id],
          country: 'ME',
          city: 'Podgorica',
        })
        .set('Cookie', adminCookie);
      await api(app)
        .patch(`/api/documents/${other}`, { subjectIds: [car.id], country: 'RS', city: 'Bar' })
        .set('Cookie', adminCookie);

      // A kind rather than a named thing — every flat at once (docs/03 §3.3.20a) — and a place, in
      // the two halves it is written in. `country=me` is the same question as `country=ME`, because
      // the code is upper-cased on the way in exactly as the PATCH upper-cases it.
      for (const query of [
        `subjectKindId=${flats.id}`,
        'country=ME',
        'country=me',
        'city=Podgorica',
        'country=ME&city=Podgorica',
      ]) {
        const res = await api(app).get(`/api/documents?${query}`).set('Cookie', adminCookie);
        const page = expectData(res, listDocumentsResponseSchema);
        expect(page.items.map((item) => item.id)).toEqual([lease]);
      }

      // Two filters on the same relation are one question and not two: a kind together with a thing
      // of another kind finds nothing, rather than finding the thing and forgetting the kind.
      const crossed = await api(app)
        .get(`/api/documents?subjectKindId=${flats.id}&subjectId=${car.id}`)
        .set('Cookie', adminCookie);
      expect(expectData(crossed, listDocumentsResponseSchema).items).toEqual([]);

      // 🔒 And the access rule still decides who any of it answers for.
      const stranger = await inviteUser(`placereader${seq}@legere.local`);
      const restricted = await givenLibrary('RESTRICTED');
      const hidden = await givenDocument({ libraryId: restricted, title: 'Hidden' });
      await api(app)
        .patch(`/api/documents/${hidden}`, { country: 'ME', city: 'Podgorica' })
        .set('Cookie', adminCookie);
      const asStranger = await api(app)
        .get('/api/documents?country=ME')
        .set('Cookie', stranger.cookie);
      expect(
        expectData(asStranger, listDocumentsResponseSchema).items.map((item) => item.id),
      ).toEqual([lease]);

      // The kind travels on the document too, so the pane can link a kind at all (docs/07 §7.3).
      const detail = await api(app).get(`/api/documents/${lease}`).set('Cookie', adminCookie);
      expect(expectData(detail, documentDetailDtoSchema).subjects).toEqual([
        {
          id: flat.id,
          kindId: flats.id,
          kind: 'apartment',
          name: 'Njegoševa 5',
          deleted: false,
        },
      ]);
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
    it('deletes a document for real, and puts its files in the trash', async () => {
      const open = await givenLibrary('ALL_USERS');
      const seeded = await seedDocument({ libraryId: open, files: [{}, {}] });

      const deleted = await api(app)
        .delete(`/api/documents/${seeded.id}`)
        .set('Cookie', adminCookie);
      expect(expectData(deleted, okResponseSchema)).toEqual({ ok: true });

      const detail = await api(app).get(`/api/documents/${seeded.id}`).set('Cookie', adminCookie);
      expect(detail.status).toBe(404);
      const page = expectData(await listAs(adminCookie), listDocumentsResponseSchema);
      expect(page.items).toEqual([]);

      // 🔒 The exception ADR-015 makes (docs/03 §3.3.10): the row is gone, not hidden, and so is
      // its place in it. What is not destroyed is the bytes — nothing rebuilds those, so the files
      // wait in the trash (docs/05 §5.7a).
      expect(await testPrisma().document.findUnique({ where: { id: seeded.id } })).toBeNull();
      expect(await testPrisma().documentPage.count({ where: { documentId: seeded.id } })).toBe(0);
      const kept = await testPrisma().file.findMany({ where: { id: { in: seeded.fileIds } } });
      expect(kept).toHaveLength(2);
      expect(kept.every((file) => file.trashedReason === 'DOCUMENT_DELETED')).toBe(true);

      // What could not go, because the volume is read-only: one ref per path, kept as the tombstone
      // that stops the next scan ingesting the same bytes into a new document (docs/03 §3.3.9).
      const refs = await testPrisma().fileRef.findMany({ where: { libraryId: open } });
      expect(refs).toHaveLength(2);
      expect(refs.map((ref) => ref.status)).toEqual(['EXCLUDED', 'EXCLUDED']);
      expect(refs.map((ref) => ref.fileId)).toEqual([null, null]);
      expect(refs.every((ref) => ref.contentHash !== null)).toBe(true);
    });

    it('takes the document off every collection it was on', async () => {
      const open = await givenLibrary('ALL_USERS');
      const documentId = await givenDocument({ libraryId: open });
      const owner = await testPrisma().user.findFirstOrThrow({ where: { role: 'ADMIN' } });
      const collection = await testPrisma().collection.create({
        data: { ownerId: owner.id, name: `Deletable ${seq}` },
      });
      await testPrisma().collectionItem.create({
        data: { collectionId: collection.id, documentId, addedById: owner.id },
      });

      const deleted = await api(app)
        .delete(`/api/documents/${documentId}`)
        .set('Cookie', adminCookie);

      // 🔒 No foreign key does this (docs/04 §4.2), so if the delete did not, the delete itself
      // would fail on the constraint — a document could not be deleted once anybody had filed it.
      expect(deleted.status).toBe(200);
      expect(await testPrisma().collectionItem.count({ where: { documentId } })).toBe(0);
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
