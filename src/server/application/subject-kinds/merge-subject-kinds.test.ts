import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../../test/helpers/fakes';
import {
  ImmediateUnitOfWork,
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
} from '../../../../test/helpers/processing-fakes';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import { MergeSubjectKinds } from './merge-subject-kinds';

// The shelves of docs/03 §3.3.20a: `car` beside `автомобиль`, holding one car twice.
async function seeded() {
  const kinds = new InMemorySubjectKindRepository();
  const subjects = new InMemorySubjectRepository(kinds);

  // The fake stamps one createdAt for everything; the merge picks the oldest, so the test says
  // which one that is.
  const aged = <T extends { createdAt: Date }>(
    map: Map<string, T>,
    id: string,
    on: string,
  ): void => {
    const row = map.get(id);
    if (row !== undefined) map.set(id, { ...row, createdAt: new Date(on) });
  };

  const car = await kinds.create({ name: 'car' });
  const avto = await kinds.create({ name: 'автомобиль' });
  aged(kinds.kinds, car.id, '2026-01-01');
  aged(kinds.kinds, avto.id, '2026-02-01');

  const lacettiCar = await subjects.create({ kindId: car.id, name: 'CHEVROLET LACETTI' });
  const lacettiAvto = await subjects.create({ kindId: avto.id, name: 'Chevrolet Lacetti' });
  aged(subjects.subjects, lacettiCar.id, '2026-01-05');
  aged(subjects.subjects, lacettiAvto.id, '2026-02-05');
  const vaz = await subjects.create({ kindId: avto.id, name: 'ВАЗ 2107' });

  // One document names the car under both spellings — the collapse case; another names only the
  // late spelling — the relink case.
  subjects.links.set('doc-both', [lacettiCar.id, lacettiAvto.id]);
  subjects.links.set('doc-late', [lacettiAvto.id]);

  return { kinds, subjects, car, avto, lacettiCar, lacettiAvto, vaz };
}

function merger(kinds: InMemorySubjectKindRepository, subjects: InMemorySubjectRepository) {
  return new MergeSubjectKinds(kinds, subjects, new ImmediateUnitOfWork(), new FixedClock());
}

describe('MergeSubjectKinds', () => {
  it('moves every subject onto the survivor and folds the things both kinds held, links deduplicated', async () => {
    const { kinds, subjects, car, avto, lacettiCar, lacettiAvto, vaz } = await seeded();

    const survivor = await merger(kinds, subjects).execute({
      ids: [car.id, avto.id],
      name: 'автомобиль',
    });

    // The oldest kind survives under the chosen name; the other shelf is gone.
    expect(survivor.id).toBe(car.id);
    expect(kinds.kinds.get(car.id)?.name).toBe('автомобиль');
    expect(kinds.kinds.get(avto.id)?.deletedAt).not.toBeNull();

    // One car, not two: the folded twin is soft-deleted, its links moved without duplicating.
    expect(subjects.subjects.get(lacettiAvto.id)?.deletedAt).not.toBeNull();
    expect(subjects.links.get('doc-both')).toEqual([lacettiCar.id]);
    expect(subjects.links.get('doc-late')).toEqual([lacettiCar.id]);

    // Everything living is filed under the survivor, names untouched.
    expect(subjects.subjects.get(vaz.id)?.kindId).toBe(car.id);
    expect(subjects.subjects.get(vaz.id)?.name).toBe('ВАЗ 2107');
    expect(subjects.subjects.get(lacettiCar.id)?.kindId).toBe(car.id);
  });

  it('refuses a survivor name that belongs to a kind outside the merge', async () => {
    const { kinds, subjects, car, avto } = await seeded();
    await kinds.create({ name: 'жильё' });

    await expect(
      merger(kinds, subjects).execute({ ids: [car.id, avto.id], name: 'жильё' }),
    ).rejects.toThrowError(ConflictError);
  });

  it('refuses an id that is not a living kind', async () => {
    const { kinds, subjects, car } = await seeded();

    await expect(
      merger(kinds, subjects).execute({ ids: [car.id, 'missing'], name: 'car' }),
    ).rejects.toThrowError(NotFoundError);
  });

  it('keeps the note it was given and the count of what it now holds', async () => {
    const { kinds, subjects, car, avto } = await seeded();

    const survivor = await merger(kinds, subjects).execute({
      ids: [car.id, avto.id],
      name: 'автомобиль',
      note: 'Also known as: car',
    });

    expect(kinds.kinds.get(car.id)?.note).toBe('Also known as: car');
    expect(survivor.name).toBe('автомобиль');
  });
});
