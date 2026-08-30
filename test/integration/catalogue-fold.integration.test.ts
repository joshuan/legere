import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CreatePerson } from '../../src/server/application/people/manage-people';
import { ConflictError } from '../../src/server/domain/errors/domain-error';
import { PersonRepository } from '../../src/server/domain/repositories/person.repository';
import { SubjectKindRepository } from '../../src/server/domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../src/server/domain/repositories/subject.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { disconnectTestPrisma, testPrisma, truncateAll } from '../helpers/db';

// The identity fold against the real database (docs/03 §3.3.19, docs/04 §4.3): the C-collation
// `lower()` never folded Cyrillic, which is exactly why these assertions run against Postgres and
// not against an in-memory fake — the fake's JavaScript lowercases everything and would prove
// nothing about the bug this guards.
describe('Catalogue identity fold (integration)', () => {
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

  it('finds the living row under a Cyrillic case-twin in all three catalogues', async () => {
    const person = await people.create({ name: 'Шершнев Евгений Константинович' });
    const kind = await kinds.create({ name: 'жильё' });
    const subject = await subjects.create({ kindId: kind.id, name: 'Красноармейская 11а' });

    // 🔒 The exact lookup every write path asks before creating (docs/03 §3.3.19): under the old
    // ILIKE these three answered null, and the twin was born.
    expect((await people.findByName('ШЕРШНЕВ ЕВГЕНИЙ КОНСТАНТИНОВИЧ'))?.id).toBe(person.id);
    expect((await kinds.findByName('ЖИЛЬЁ'))?.id).toBe(kind.id);
    expect((await subjects.findByKindAndName(kind.id, 'КРАСНОАРМЕЙСКАЯ 11А'))?.id).toBe(subject.id);
  });

  it('links the existing row when a name arrives in another case', async () => {
    // The analysis path in miniature (docs/03 §3.3.19): find on the fold, create only on null —
    // so a case-twin answer reuses the row instead of spawning a twenty-third spelling.
    const first = await people.create({ name: 'Марија Петровић' });
    const found = await people.findByName('МАРИЈА ПЕТРОВИЋ');
    const linked = found ?? (await people.create({ name: 'МАРИЈА ПЕТРОВИЋ' }));

    expect(linked.id).toBe(first.id);
    expect((await people.listActive()).length).toBe(1);
  });

  it('keeps a renamed row findable under its new fold, not its old one', async () => {
    const person = await people.create({ name: 'ASIANINA VIKTORIA' });
    await people.update(person.id, { name: 'Асянина Виктория' });

    expect((await people.findByName('асянина виктория'))?.id).toBe(person.id);
    expect(await people.findByName('ASIANINA VIKTORIA')).toBeNull();
  });

  // The other half of the fold's honesty (docs/03 §3.3.19, M47.14/SEC-76): a `%` or `_` in a name
  // is a letter, because the uniqueness check is `nameFolded` equality. Under the old ILIKE
  // predicate the user's characters compiled into a pattern, and '100% Ltd' — whose `%` swallows
  // anything — "found" a stranger and answered a duplicate that was not one.
  it('matches a wildcard-carrying name as letters, not as a pattern', async () => {
    const create = new CreatePerson(people);
    // The stranger a wildcard reading would swallow: '100% Ltd' matches it as a pattern ('%' takes
    // the X), and so does '100_ Ltd' ('_' takes exactly one character).
    const letters = await create.execute({ name: '100X Ltd' });

    // (b) Both wildcard-carrying names create their own rows: the wildcard did not wildcard, so the
    // duplicate check found nothing where only a pattern match would have.
    const percent = await create.execute({ name: '100% Ltd' });
    const underscore = await create.execute({ name: '100_ Ltd' });
    expect(percent.id).not.toBe(letters.id);
    expect(underscore.id).not.toBe(letters.id);

    // (a) The name itself, again, is a duplicate — the ConflictError the API answers as 409: the
    // wildcard character is matched as the letter it is, equal to itself and to nothing else.
    await expect(create.execute({ name: '100% Ltd' })).rejects.toThrow(ConflictError);
    await expect(create.execute({ name: '100_ Ltd' })).rejects.toThrow(ConflictError);

    // 🔒 And the exact lookup every write path asks answers each row only under its own letters.
    expect((await people.findByName('100% LTD'))?.id).toBe(percent.id);
    expect((await people.findByName('100_ ltd'))?.id).toBe(underscore.id);
    expect(await people.findByName('100? Ltd')).toBeNull();
  });

  // Since M49.4 the fold's uniqueness is the database's too (docs/04 §4.3): the migration replaced
  // the ASCII-blind lower(name) indexes with partial unique indexes over the fold. These tests go
  // straight to the repositories — past the application's check, the way the loser of a race
  // arrives — and expect the same named 409, not a 500.
  it('carries the unique fold indexes, and no lower(name) ones', async () => {
    const rows = await testPrisma().$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE tablename IN ('people', 'subjects', 'subject_kinds')`;
    const names = rows.map((row) => row.indexname);
    expect(names).toContain('people_name_folded_uq');
    expect(names).toContain('subjects_kind_name_folded_uq');
    expect(names).toContain('subject_kinds_name_folded_uq');
    expect(names).not.toContain('people_name_active_uq');
    expect(names).not.toContain('subjects_kind_name_active_uq');
    expect(names).not.toContain('subject_kinds_name_active_uq');
  });

  it('🔒 refuses the case-twin a raced write slips past the check, as the named conflict', async () => {
    await people.create({ name: 'Шершнев Евгений' });
    await expect(people.create({ name: 'ШЕРШНЕВ ЕВГЕНИЙ' })).rejects.toMatchObject({
      code: 'PERSON_EXISTS',
    });

    const kind = await kinds.create({ name: 'жильё' });
    await expect(kinds.create({ name: 'ЖИЛЬЁ' })).rejects.toMatchObject({
      code: 'SUBJECT_KIND_EXISTS',
    });

    await subjects.create({ kindId: kind.id, name: 'Красноармейская 11а' });
    await expect(
      subjects.create({ kindId: kind.id, name: 'КРАСНОАРМЕЙСКАЯ 11А' }),
    ).rejects.toMatchObject({ code: 'SUBJECT_EXISTS' });

    // A rename can lose the same race: the index answers for updates too.
    const other = await people.create({ name: 'Другой Человек' });
    await expect(people.update(other.id, { name: 'шершнев евгений' })).rejects.toMatchObject({
      code: 'PERSON_EXISTS',
    });
  });

  it('leaves soft-deleted twins outside the namespace, as the partial index promises', async () => {
    // The shape every merge leaves behind (docs/04 §4.3): the losers are soft-deleted rows whose
    // folds collide with the survivor's — exactly what the index must tolerate to have applied on
    // a just-cleaned instance at all.
    const first = await people.create({ name: 'Рончевић Нада' });
    await people.softDelete(first.id, new Date());
    const second = await people.create({ name: 'РОНЧЕВИЋ НАДА' });
    expect(second.id).not.toBe(first.id);
  });
});
