import { describe, expect, it } from 'vitest';
import {
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
  ImmediateUnitOfWork,
} from '../../../../test/helpers/processing-fakes';
import { FixedClock } from '../../../../test/helpers/fakes';
import { MAX_LIVING_SUBJECTS } from '../../domain/entities/subject';
import { ConflictError, UnprocessableError } from '../../domain/errors/domain-error';
import { CreateSubject, MergeSubjects } from './manage-subjects';

type Seeded = {
  kinds: InMemorySubjectKindRepository;
  subjects: InMemorySubjectRepository;
  kindId: string;
};

async function catalogueAtTheCeiling(): Promise<Seeded> {
  const kinds = new InMemorySubjectKindRepository();
  const subjects = new InMemorySubjectRepository(kinds);
  const car = await kinds.create({ name: 'car' });
  for (let index = 1; index <= MAX_LIVING_SUBJECTS; index += 1) {
    await subjects.create({ kindId: car.id, name: `Thing ${index}` });
  }
  return { kinds, subjects, kindId: car.id };
}

// 🔒 The instance ceiling behind the catalogue throttle (docs/08 §8.4, SEC-56): a throttle bounds a
// rate, only a count bounds a total, and the catalogue is a namespace every user reads.
describe('CreateSubject at the catalogue ceiling', () => {
  it('refuses the row past the ceiling with CATALOGUE_FULL and writes nothing', async () => {
    const { kinds, subjects, kindId } = await catalogueAtTheCeiling();

    await expect(
      new CreateSubject(subjects, kinds).execute({ kindId, name: 'One Too Many' }),
    ).rejects.toMatchObject({ code: 'CATALOGUE_FULL', httpStatus: 422 });
    await expect(
      new CreateSubject(subjects, kinds).execute({ kindId, name: 'One Too Many' }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    expect(await subjects.countActive()).toBe(MAX_LIVING_SUBJECTS);
  });

  it('still tells a duplicate it exists: a living (kind, name) answers SUBJECT_EXISTS, not full', async () => {
    const { kinds, subjects, kindId } = await catalogueAtTheCeiling();

    await expect(
      new CreateSubject(subjects, kinds).execute({ kindId, name: 'Thing 1' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('counts living rows only, so a delete or a merge makes room again', async () => {
    const { kinds, subjects, kindId } = await catalogueAtTheCeiling();
    const one = await subjects.findByKindAndName(kindId, 'Thing 1');
    if (one === null) throw new Error('The seeded subject is missing');
    await subjects.softDelete(one.id, new Date('2026-08-01T00:00:00.000Z'));

    const created = await new CreateSubject(subjects, kinds).execute({
      kindId,
      name: 'Back In The Room',
    });

    expect(created.name).toBe('Back In The Room');
    expect(await subjects.countActive()).toBe(MAX_LIVING_SUBJECTS);
  });
});

describe('MergeSubjects address recognition', () => {
  it('retains both former addresses in the existing note', async () => {
    const kinds = new InMemorySubjectKindRepository();
    const subjects = new InMemorySubjectRepository(kinds);
    const kind = await kinds.create({ name: 'Жильё' });
    const cvetanova = await subjects.create({
      kindId: kind.id,
      name: 'Beograd, Cvetanova ćuprija 24Ђ/2',
    });
    const srdjana = await subjects.create({
      kindId: kind.id,
      name: 'Srđana Kneževića 8,12, stan 2/8',
    });

    const merged = await new MergeSubjects(
      subjects,
      kinds,
      new ImmediateUnitOfWork(),
      new FixedClock(),
    ).execute({
      ids: [cvetanova.id, srdjana.id],
      kindId: kind.id,
      name: cvetanova.name,
      note: null,
    });

    expect(merged.note).toContain('Srđana Kneževića 8,12, stan 2/8');
  });
});
