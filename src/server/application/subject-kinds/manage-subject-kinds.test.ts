import { describe, expect, it } from 'vitest';
import { InMemorySubjectKindRepository } from '../../../../test/helpers/processing-fakes';
import { MAX_LIVING_SUBJECT_KINDS } from '../../domain/entities/subject-kind';
import { ConflictError, UnprocessableError } from '../../domain/errors/domain-error';
import { CreateSubjectKind } from './manage-subject-kinds';

async function catalogueAtTheCeiling(): Promise<InMemorySubjectKindRepository> {
  const kinds = new InMemorySubjectKindRepository();
  for (let index = 1; index <= MAX_LIVING_SUBJECT_KINDS; index += 1) {
    await kinds.create({ name: `kind ${index}` });
  }
  return kinds;
}

// 🔒 The tightest of the three instance ceilings (docs/08 §8.4, SEC-51, SEC-56): every living kind
// is text the analysis carries, so this catalogue is the one a flood turns into money fastest.
describe('CreateSubjectKind at the catalogue ceiling', () => {
  it('refuses the row past the ceiling with CATALOGUE_FULL and writes nothing', async () => {
    const kinds = await catalogueAtTheCeiling();

    await expect(
      new CreateSubjectKind(kinds).execute({ name: 'one too many' }),
    ).rejects.toMatchObject({ code: 'CATALOGUE_FULL', httpStatus: 422 });
    await expect(
      new CreateSubjectKind(kinds).execute({ name: 'one too many' }),
    ).rejects.toBeInstanceOf(UnprocessableError);
    expect(await kinds.countActive()).toBe(MAX_LIVING_SUBJECT_KINDS);
  });

  it('still tells a duplicate it exists: a name that already lives answers SUBJECT_KIND_EXISTS, not full', async () => {
    const kinds = await catalogueAtTheCeiling();

    await expect(new CreateSubjectKind(kinds).execute({ name: 'kind 1' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('counts living rows only, so a delete or a merge makes room again', async () => {
    const kinds = await catalogueAtTheCeiling();
    const one = await kinds.findByName('kind 1');
    if (one === null) throw new Error('The seeded kind is missing');
    await kinds.softDelete(one.id, new Date('2026-08-01T00:00:00.000Z'));

    const created = await new CreateSubjectKind(kinds).execute({ name: 'back in the room' });

    expect(created.name).toBe('back in the room');
    expect(await kinds.countActive()).toBe(MAX_LIVING_SUBJECT_KINDS);
  });
});
