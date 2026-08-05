import type {
  CreatePersonRequest,
  MergePeopleRequest,
  ListPeopleResponse,
  PersonDto,
  UpdatePersonRequest,
} from '../../../shared/contracts/people';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import type { Clock } from '../ports/clock';

// People are a catalogue everybody adds to and only an admin tidies (docs/03 §3.3.19). Reading and
// adding are open, because the analyst adds names on its own and whoever corrects it must be able to
// do the same; renaming and removing are an admin's, since both reach across every document that
// names them.
export class ListPeople {
  constructor(private readonly people: PersonRepository) {}

  async execute(): Promise<ListPeopleResponse> {
    const rows = await this.people.listActive();
    return {
      items: rows.map((person) => ({
        id: person.id,
        name: person.name,
        note: person.note,
        documentCount: person.documentCount,
      })),
    };
  }
}

export class CreatePerson {
  constructor(private readonly people: PersonRepository) {}

  async execute(input: CreatePersonRequest): Promise<PersonDto> {
    // 🔒 One row per living name: a catalogue is only worth having if the same person is the same
    // row (docs/04 §4.3).
    const existing = await this.people.findByName(input.name);
    if (existing !== null) {
      throw new ConflictError('PERSON_EXISTS', 'A person with this name already exists');
    }

    const created = await this.people.create({ name: input.name, note: input.note ?? null });
    return { id: created.id, name: created.name, note: created.note, documentCount: 0 };
  }
}

export class UpdatePerson {
  constructor(private readonly people: PersonRepository) {}

  async execute(id: string, input: UpdatePersonRequest): Promise<PersonDto> {
    const person = await this.people.findById(id);
    if (person === null) throw new NotFoundError('PERSON_NOT_FOUND', 'Person not found');

    if (input.name !== undefined) {
      const clash = await this.people.findByName(input.name);
      if (clash !== null && clash.id !== id) {
        throw new ConflictError('PERSON_EXISTS', 'A person with this name already exists');
      }
    }

    const updated = await this.people.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    const counted = (await this.people.listActive()).find((row) => row.id === id);
    return {
      id: updated.id,
      name: updated.name,
      note: updated.note,
      documentCount: counted?.documentCount ?? 0,
    };
  }
}

export class DeletePerson {
  constructor(
    private readonly people: PersonRepository,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<void> {
    const person = await this.people.findById(id);
    if (person === null) throw new NotFoundError('PERSON_NOT_FOUND', 'Person not found');
    // Soft delete keeps the links (ADR-015): the documents still say who they were about, and only
    // new documents stop being able to name them.
    await this.people.softDelete(id, this.clock.now());
  }
}

// Four rows for one person, because the analysis read four spellings of one name. Merging keeps the
// oldest row — the one the archive has been calling this person longest — renames it to whatever was
// chosen, moves every document link onto it and soft-deletes the rest (docs/03 §3.3.19).
//
// One transaction: a merge that moved half the links and then failed would leave documents pointing
// at a person nobody can see.
export class MergePeople {
  constructor(
    private readonly people: PersonRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: MergePeopleRequest): Promise<PersonDto> {
    const rows = await this.people.findByIds(input.ids);
    if (rows.length !== input.ids.length) {
      throw new NotFoundError('PERSON_NOT_FOUND', 'Person not found');
    }

    // 🔒 The surviving name must not collide with somebody who was not part of the merge — that
    // would be two people becoming one by accident, which is the opposite of the point.
    const clash = await this.people.findByName(input.name);
    if (clash !== null && !input.ids.includes(clash.id)) {
      throw new ConflictError('PERSON_EXISTS', 'Somebody else is already called that');
    }

    const survivor = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (survivor === undefined) throw new NotFoundError('PERSON_NOT_FOUND', 'Person not found');
    const merged = input.ids.filter((id) => id !== survivor.id);

    const now = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      await this.people.moveDocumentLinks(merged, survivor.id, tx);
      await this.people.update(
        survivor.id,
        { name: input.name, ...(input.note === undefined ? {} : { note: input.note }) },
        tx,
      );
      for (const id of merged) await this.people.softDelete(id, now, tx);
    });

    const counted = (await this.people.listActive()).find((row) => row.id === survivor.id);
    return {
      id: survivor.id,
      name: input.name,
      note: counted?.note ?? null,
      documentCount: counted?.documentCount ?? 0,
    };
  }
}
