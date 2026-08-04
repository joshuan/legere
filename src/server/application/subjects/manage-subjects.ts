import type {
  CreateSubjectRequest,
  ListSubjectsResponse,
  SubjectDto,
  UpdateSubjectRequest,
} from '../../../shared/contracts/subjects';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import type { Clock } from '../ports/clock';

// The same access shape as people (docs/03 §3.3.19–20): reading and adding are open, because the
// analysis adds things on its own and whoever corrects it must be able to; renaming and removing are
// an admin's, since both reach across every document about that thing.
export class ListSubjects {
  constructor(private readonly subjects: SubjectRepository) {}

  async execute(): Promise<ListSubjectsResponse> {
    const rows = await this.subjects.listActive();
    return {
      items: rows.map((subject) => ({
        id: subject.id,
        kind: subject.kind,
        name: subject.name,
        note: subject.note,
        documentCount: subject.documentCount,
      })),
    };
  }
}

export class CreateSubject {
  constructor(private readonly subjects: SubjectRepository) {}

  async execute(input: CreateSubjectRequest): Promise<SubjectDto> {
    // 🔒 One row per living (kind, name): the same flat named twice is the failure the catalogue
    // exists to prevent (docs/04 §4.3).
    const existing = await this.subjects.findByKindAndName(input.kind, input.name);
    if (existing !== null) {
      throw new ConflictError('SUBJECT_EXISTS', 'This thing is already in the list');
    }

    const created = await this.subjects.create({
      kind: input.kind,
      name: input.name,
      note: input.note ?? null,
    });
    return {
      id: created.id,
      kind: created.kind,
      name: created.name,
      note: created.note,
      documentCount: 0,
    };
  }
}

export class UpdateSubject {
  constructor(private readonly subjects: SubjectRepository) {}

  async execute(id: string, input: UpdateSubjectRequest): Promise<SubjectDto> {
    const subject = await this.subjects.findById(id);
    if (subject === null) throw new NotFoundError('SUBJECT_NOT_FOUND', 'Subject not found');

    const kind = input.kind ?? subject.kind;
    const name = input.name ?? subject.name;
    const clash = await this.subjects.findByKindAndName(kind, name);
    if (clash !== null && clash.id !== id) {
      throw new ConflictError('SUBJECT_EXISTS', 'This thing is already in the list');
    }

    const updated = await this.subjects.update(id, {
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    const counted = (await this.subjects.listActive()).find((row) => row.id === id);
    return {
      id: updated.id,
      kind: updated.kind,
      name: updated.name,
      note: updated.note,
      documentCount: counted?.documentCount ?? 0,
    };
  }
}

export class DeleteSubject {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<void> {
    const subject = await this.subjects.findById(id);
    if (subject === null) throw new NotFoundError('SUBJECT_NOT_FOUND', 'Subject not found');
    // Soft delete keeps the links (ADR-015): the documents still say what they were about.
    await this.subjects.softDelete(id, this.clock.now());
  }
}
