import { describe, expect, it } from 'vitest';
import { InMemoryPersonRepository } from '../../../../test/helpers/processing-fakes';
import { MAX_LIVING_PEOPLE } from '../../domain/entities/person';
import { ConflictError, UnprocessableError } from '../../domain/errors/domain-error';
import { CreatePerson } from './manage-people';

async function catalogueAtTheCeiling(): Promise<InMemoryPersonRepository> {
  const people = new InMemoryPersonRepository();
  for (let index = 1; index <= MAX_LIVING_PEOPLE; index += 1) {
    await people.create({ name: `Person ${index}` });
  }
  return people;
}

// 🔒 The instance ceiling behind the catalogue throttle (docs/08 §8.4, SEC-56): a throttle bounds a
// rate, only a count bounds a total, and the catalogue is a namespace every user reads.
describe('CreatePerson at the catalogue ceiling', () => {
  it('refuses the row past the ceiling with CATALOGUE_FULL and writes nothing', async () => {
    const people = await catalogueAtTheCeiling();

    await expect(new CreatePerson(people).execute({ name: 'One Too Many' })).rejects.toMatchObject({
      code: 'CATALOGUE_FULL',
      httpStatus: 422,
    });
    await expect(new CreatePerson(people).execute({ name: 'One Too Many' })).rejects.toBeInstanceOf(
      UnprocessableError,
    );
    expect(await people.countActive()).toBe(MAX_LIVING_PEOPLE);
  });

  it('still tells a duplicate it exists: a name that already lives answers PERSON_EXISTS, not full', async () => {
    const people = await catalogueAtTheCeiling();

    await expect(new CreatePerson(people).execute({ name: 'Person 1' })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('counts living rows only, so a delete or a merge makes room again', async () => {
    const people = await catalogueAtTheCeiling();
    const someone = await people.findByName('Person 1');
    if (someone === null) throw new Error('The seeded person is missing');
    await people.softDelete(someone.id, new Date('2026-08-01T00:00:00.000Z'));

    const created = await new CreatePerson(people).execute({ name: 'Back In The Room' });

    expect(created.name).toBe('Back In The Room');
    expect(await people.countActive()).toBe(MAX_LIVING_PEOPLE);
  });
});
