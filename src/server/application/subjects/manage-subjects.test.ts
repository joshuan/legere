import { describe, expect, it } from 'vitest';
import {
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
} from '../../../../test/helpers/processing-fakes';
import { MAX_LIVING_SUBJECTS } from '../../domain/entities/subject';
import { ConflictError, UnprocessableError } from '../../domain/errors/domain-error';
import { CreateSubject } from './manage-subjects';

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
