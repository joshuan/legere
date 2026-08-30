import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogueOrder, CatalogueSort } from '../../src/shared/contracts/common';
import { UnprocessableError } from '../../src/server/domain/errors/domain-error';
import { PersonRepository } from '../../src/server/domain/repositories/person.repository';
import { SubjectKindRepository } from '../../src/server/domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../src/server/domain/repositories/subject.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';

// M56.3 against the real database (docs/07 §7.3, docs/11 §11.12a): `lastDocumentAt` is the newest
// `documentDate` among the **living** documents that name a row — for a kind, across its things —
// and the named orders are keyset-paged with the cursor bound to the sort that minted it. Every
// assertion here needs Postgres: the aggregation, the NULLS-LAST placement and the keyset
// predicate are SQL, and an in-memory fake would prove none of them.
describe('Catalogue lists (integration)', () => {
  let people: PersonRepository;
  let subjects: SubjectRepository;
  let kinds: SubjectKindRepository;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();
    people = moduleRef.get(PersonRepository);
    subjects = moduleRef.get(SubjectRepository);
    kinds = moduleRef.get(SubjectKindRepository);
    close = () => moduleRef.close();
    await truncateAll();
  });

  afterEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  // A document with the date on its paper, and who/what it names. `deletedAt` makes it one the
  // catalogues must not count (ADR-015).
  async function document(input: {
    title: string;
    date: string | null;
    personIds?: string[];
    subjectIds?: string[];
    deleted?: boolean;
  }): Promise<string> {
    const created = await testPrisma().document.create({
      data: {
        title: input.title,
        documentDate: input.date === null ? null : new Date(`${input.date}T00:00:00.000Z`),
        deletedAt: input.deleted === true ? new Date('2026-08-01T00:00:00.000Z') : null,
        people: { create: (input.personIds ?? []).map((personId) => ({ personId })) },
        subjects: { create: (input.subjectIds ?? []).map((subjectId) => ({ subjectId })) },
      },
    });
    return created.id;
  }

  const page = (sort: CatalogueSort, order: CatalogueOrder, limit = 50) => ({
    limit,
    sort,
    order,
  });

  describe('lastDocumentAt', () => {
    it('is the newest date among the living documents naming the row, and null without one', async () => {
      const named = await people.create({ name: 'Marija' });
      const undated = await people.create({ name: 'Ana' });
      const unnamed = await people.create({ name: 'Nobody' });

      await document({ title: 'old', date: '2019-07-04', personIds: [named.id] });
      await document({ title: 'new', date: '2024-02-01', personIds: [named.id] });
      // 🔒 A deleted document names nobody as far as the catalogue is concerned: it is not in the
      // browse the count is a door to, so it may not decide the date either.
      await document({ title: 'gone', date: '2030-01-01', personIds: [named.id], deleted: true });
      await document({ title: 'undated', date: null, personIds: [undated.id] });

      const rows = (await people.listPage(page('name', 'asc'))).items;
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(named.id)?.lastDocumentAt).toEqual(new Date('2024-02-01T00:00:00.000Z'));
      expect(byId.get(named.id)?.documentCount).toBe(2);
      // A document with no date on it leaves the row dateless, not zero-dated.
      expect(byId.get(undated.id)?.lastDocumentAt).toBeNull();
      expect(byId.get(undated.id)?.documentCount).toBe(1);
      expect(byId.get(unnamed.id)?.lastDocumentAt).toBeNull();
      expect(byId.get(unnamed.id)?.documentCount).toBe(0);
    });

    it('reaches a kind across its living things', async () => {
      const flat = await kinds.create({ name: 'apartment' });
      const empty = await kinds.create({ name: 'boat' });
      const one = await subjects.create({ kindId: flat.id, name: 'Njegoševa 5' });
      const two = await subjects.create({ kindId: flat.id, name: 'Krunska 12' });
      const buried = await subjects.create({ kindId: flat.id, name: 'Sold long ago' });

      await document({ title: 'lease', date: '2021-03-03', subjectIds: [one.id] });
      await document({ title: 'bill', date: '2023-11-30', subjectIds: [two.id] });
      // 🔒 A soft-deleted thing is not something the kind still holds (ADR-015), so neither its
      // documents nor their dates reach the shelf.
      await document({ title: 'ancient', date: '2031-01-01', subjectIds: [buried.id] });
      await subjects.softDelete(buried.id, new Date('2026-08-01T00:00:00.000Z'));

      const rows = (await kinds.listPage(page('name', 'asc'))).items;
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(flat.id)?.lastDocumentAt).toEqual(new Date('2023-11-30T00:00:00.000Z'));
      expect(byId.get(flat.id)?.subjectCount).toBe(2);
      expect(byId.get(flat.id)?.documentCount).toBe(2);
      expect(byId.get(empty.id)?.lastDocumentAt).toBeNull();
      expect(byId.get(empty.id)?.subjectCount).toBe(0);
    });
  });

  describe('the named orders', () => {
    // Three people: one spoken of recently, one long ago, one the archive has no dated paper for.
    async function catalogue(): Promise<{ recent: string; old: string; dateless: string }> {
      const recent = await people.create({ name: 'Boris' });
      const old = await people.create({ name: 'Ana' });
      const dateless = await people.create({ name: 'Vera' });
      await document({ title: 'a', date: '2024-02-01', personIds: [recent.id] });
      await document({ title: 'b', date: '2024-01-01', personIds: [recent.id] });
      await document({ title: 'c', date: '2019-07-04', personIds: [old.id] });
      await document({ title: 'd', date: null, personIds: [dateless.id] });
      return { recent: recent.id, old: old.id, dateless: dateless.id };
    }

    it('opens on what the archive last spoke of, with the dateless rows last', async () => {
      const { recent, old, dateless } = await catalogue();

      const desc = await people.listPage(page('lastDocumentAt', 'desc'));

      expect(desc.items.map((row) => row.id)).toEqual([recent, old, dateless]);
    });

    it('keeps the dateless rows last under the other direction too', async () => {
      const { recent, old, dateless } = await catalogue();

      const asc = await people.listPage(page('lastDocumentAt', 'asc'));

      // 🔒 NULLS LAST both ways (docs/11 §11.12a): a row the archive has no dated paper for is the
      // least current answer to "what did the paper last name", whichever way the column is read —
      // and `ORDER BY … ASC` would otherwise put the whole dateless block first.
      expect(asc.items.map((row) => row.id)).toEqual([old, recent, dateless]);
    });

    it('sorts by the counts and by the name', async () => {
      const { recent, old, dateless } = await catalogue();

      const byDocuments = await people.listPage(page('documents', 'desc'));
      expect(byDocuments.items[0]?.id).toBe(recent);
      expect(byDocuments.items[0]?.documentCount).toBe(2);

      const byName = await people.listPage(page('name', 'asc'));
      expect(byName.items.map((row) => row.name)).toEqual(['Ana', 'Boris', 'Vera']);
      expect((await people.listPage(page('name', 'desc'))).items.map((row) => row.name)).toEqual([
        'Vera',
        'Boris',
        'Ana',
      ]);

      // The kinds catalogue counts one thing more (docs/07 §7.3).
      const flat = await kinds.create({ name: 'apartment' });
      await kinds.create({ name: 'boat' });
      await subjects.create({ kindId: flat.id, name: 'Njegoševa 5' });
      const byThings = await kinds.listPage({ limit: 50, sort: 'things', order: 'desc' });
      expect(byThings.items[0]?.id).toBe(flat.id);
      expect(byThings.items[0]?.subjectCount).toBe(1);
      expect(old).not.toBe(dateless);
    });
  });

  describe('the cursor', () => {
    it('pages through every order without skipping or repeating a row, dateless block included', async () => {
      const created: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        const person = await people.create({ name: `Person ${index}` });
        created.push(person.id);
        // Four dated rows sharing two dates — so the keyset has ties to break — and three the
        // archive knows no date for, which is the block the predicate has its third branch for.
        if (index < 4) {
          await document({
            title: `doc ${index}`,
            date: index < 2 ? '2024-02-01' : '2019-07-04',
            personIds: [person.id],
          });
        }
      }

      for (const [sort, order] of [
        ['lastDocumentAt', 'desc'],
        ['lastDocumentAt', 'asc'],
        ['documents', 'desc'],
        ['name', 'asc'],
      ] as const) {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const answer = await people.listPage({
            limit: 2,
            sort,
            order,
            ...(cursor === undefined ? {} : { cursor }),
          });
          seen.push(...answer.items.map((row) => row.id));
          cursor = answer.nextCursor ?? undefined;
        } while (cursor !== undefined);

        // Every row exactly once, and in the order a single unpaged read gives.
        expect(new Set(seen).size).toBe(created.length);
        const whole = await people.listPage({ limit: 50, sort, order });
        expect(seen).toEqual(whole.items.map((row) => row.id));
      }
    });

    it('refuses a cursor minted under one sort when another is asked for', async () => {
      for (let index = 0; index < 3; index += 1) {
        await people.create({ name: `Person ${index}` });
      }
      const first = await people.listPage({ limit: 1, sort: 'lastDocumentAt', order: 'desc' });
      const cursor = first.nextCursor ?? '';
      expect(cursor).not.toBe('');

      // 🔒 The documents list's rule (docs/07 §7.1): a keyset predicate read off another column —
      // or under the other direction — answers rather than failing, skipping and repeating rows
      // while looking like an ordinary page.
      await expect(
        people.listPage({ limit: 1, sort: 'name', order: 'desc', cursor }),
      ).rejects.toBeInstanceOf(UnprocessableError);
      await expect(
        people.listPage({ limit: 1, sort: 'lastDocumentAt', order: 'asc', cursor }),
      ).rejects.toMatchObject({ code: 'CURSOR_SORT_MISMATCH', httpStatus: 422 });

      // The sort it was minted under continues normally.
      const continued = await people.listPage({
        limit: 1,
        sort: 'lastDocumentAt',
        order: 'desc',
        cursor,
      });
      expect(continued.items).toHaveLength(1);
      expect(continued.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it('refuses a mismatched cursor on the other two catalogues too', async () => {
      const kind = await kinds.create({ name: 'apartment' });
      await kinds.create({ name: 'boat' });
      await subjects.create({ kindId: kind.id, name: 'Njegoševa 5' });
      await subjects.create({ kindId: kind.id, name: 'Krunska 12' });

      const kindsPage = await kinds.listPage({ limit: 1, sort: 'things', order: 'desc' });
      await expect(
        kinds.listPage({
          limit: 1,
          sort: 'documents',
          order: 'desc',
          cursor: kindsPage.nextCursor ?? '',
        }),
      ).rejects.toMatchObject({ code: 'CURSOR_SORT_MISMATCH' });

      const subjectsPage = await subjects.listPage({ limit: 1, sort: 'name', order: 'asc' });
      await expect(
        subjects.listPage({
          limit: 1,
          sort: 'lastDocumentAt',
          order: 'desc',
          cursor: subjectsPage.nextCursor ?? '',
        }),
      ).rejects.toMatchObject({ code: 'CURSOR_SORT_MISMATCH' });
    });

    it('starts the list over on a cursor it cannot read, rather than erroring', async () => {
      await people.create({ name: 'Ana' });
      await people.create({ name: 'Boris' });

      const forged = Buffer.from('nonsense').toString('base64url');
      const answer = await people.listPage({
        limit: 50,
        sort: 'name',
        order: 'asc',
        cursor: forged,
      });

      expect(answer.items.map((row) => row.name)).toEqual(['Ana', 'Boris']);
    });
  });

  describe('findListRow', () => {
    it('answers one row on the list own terms, and nothing for a dead one', async () => {
      const person = await people.create({ name: 'Marija' });
      await document({ title: 'a', date: '2022-05-05', personIds: [person.id] });

      const row = await people.findListRow(person.id);
      expect(row).toMatchObject({
        id: person.id,
        documentCount: 1,
        lastDocumentAt: new Date('2022-05-05T00:00:00.000Z'),
      });

      await people.softDelete(person.id, new Date('2026-08-01T00:00:00.000Z'));
      expect(await people.findListRow(person.id)).toBeNull();
    });
  });
});
