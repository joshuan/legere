import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PersonRepository } from '../../src/server/domain/repositories/person.repository';
import { SubjectKindRepository } from '../../src/server/domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../src/server/domain/repositories/subject.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';

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
});
