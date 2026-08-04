import type {
  CreateSubjectRequest,
  ListSubjectsResponse,
  SubjectDto,
  UpdateSubjectRequest,
} from '../../../shared/contracts/subjects';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
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
        kindId: subject.kindId,
        kind: subject.kind,
        name: subject.name,
        note: subject.note,
        documentCount: subject.documentCount,
      })),
    };
  }
}

export class CreateSubject {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly kinds: SubjectKindRepository,
  ) {}

  async execute(input: CreateSubjectRequest): Promise<SubjectDto> {
    // The kind is chosen from the catalogue, and one that is not in it is a wrong request rather
    // than a new kind: creating a kind is its own call (docs/03 §3.3.20a).
    const kind = await this.kinds.findById(input.kindId);
    if (kind === null) throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');

    // 🔒 One row per living (kind, name): the same flat named twice is the failure the catalogue
    // exists to prevent (docs/04 §4.3).
    const existing = await this.subjects.findByKindAndName(kind.id, input.name);
    if (existing !== null) {
      throw new ConflictError('SUBJECT_EXISTS', 'This thing is already in the list');
    }

    const created = await this.subjects.create({
      kindId: kind.id,
      name: input.name,
      note: input.note ?? null,
    });
    return {
      id: created.id,
      kindId: created.kindId,
      kind: created.kind,
      name: created.name,
      note: created.note,
      documentCount: 0,
    };
  }
}

export class UpdateSubject {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly kinds: SubjectKindRepository,
  ) {}

  async execute(id: string, input: UpdateSubjectRequest): Promise<SubjectDto> {
    const subject = await this.subjects.findById(id);
    if (subject === null) throw new NotFoundError('SUBJECT_NOT_FOUND', 'Subject not found');

    // Moving a thing to another kind is an ordinary correction — a boat filed as a country — so the
    // kind may change, but only to one that exists.
    if (input.kindId !== undefined && (await this.kinds.findById(input.kindId)) === null) {
      throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');
    }

    const kindId = input.kindId ?? subject.kindId;
    const name = input.name ?? subject.name;
    const clash = await this.subjects.findByKindAndName(kindId, name);
    if (clash !== null && clash.id !== id) {
      throw new ConflictError('SUBJECT_EXISTS', 'This thing is already in the list');
    }

    const updated = await this.subjects.update(id, {
      ...(input.kindId === undefined ? {} : { kindId: input.kindId }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    const counted = (await this.subjects.listActive()).find((row) => row.id === id);
    return {
      id: updated.id,
      kindId: updated.kindId,
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
