import type {
  CreateSubjectKindRequest,
  ListSubjectKindsResponse,
  SubjectKindDto,
  UpdateSubjectKindRequest,
} from '../../../shared/contracts/subject-kinds';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import type { Clock } from '../ports/clock';

// The same access shape as people and subjects (docs/03 §3.3.19–20a): reading and adding are open,
// because the analysis adds kinds on its own and whoever corrects it must be able to; renaming and
// removing are an admin's, since both reach across every thing filed under that kind.
export class ListSubjectKinds {
  constructor(private readonly kinds: SubjectKindRepository) {}

  async execute(): Promise<ListSubjectKindsResponse> {
    const rows = await this.kinds.listActive();
    return {
      items: rows.map((kind) => ({
        id: kind.id,
        name: kind.name,
        note: kind.note,
        subjectCount: kind.subjectCount,
        documentCount: kind.documentCount,
      })),
    };
  }
}

export class CreateSubjectKind {
  constructor(private readonly kinds: SubjectKindRepository) {}

  async execute(input: CreateSubjectKindRequest): Promise<SubjectKindDto> {
    // 🔒 One row per living name: the same kind under two spellings is the failure the catalogue
    // exists to prevent (docs/03 §3.3.20a).
    const existing = await this.kinds.findByName(input.name);
    if (existing !== null) {
      throw new ConflictError('SUBJECT_KIND_EXISTS', 'This kind is already in the list');
    }

    const created = await this.kinds.create({ name: input.name, note: input.note ?? null });
    return {
      id: created.id,
      name: created.name,
      note: created.note,
      subjectCount: 0,
      documentCount: 0,
    };
  }
}

export class UpdateSubjectKind {
  constructor(private readonly kinds: SubjectKindRepository) {}

  async execute(id: string, input: UpdateSubjectKindRequest): Promise<SubjectKindDto> {
    const kind = await this.kinds.findById(id);
    if (kind === null) throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');

    if (input.name !== undefined) {
      const clash = await this.kinds.findByName(input.name);
      if (clash !== null && clash.id !== id) {
        throw new ConflictError('SUBJECT_KIND_EXISTS', 'This kind is already in the list');
      }
    }

    const updated = await this.kinds.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.note === undefined ? {} : { note: input.note }),
    });
    const counted = (await this.kinds.listActive()).find((row) => row.id === id);
    return {
      id: updated.id,
      name: updated.name,
      note: updated.note,
      subjectCount: counted?.subjectCount ?? 0,
      documentCount: counted?.documentCount ?? 0,
    };
  }
}

export class DeleteSubjectKind {
  constructor(
    private readonly kinds: SubjectKindRepository,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<void> {
    const kind = await this.kinds.findById(id);
    if (kind === null) throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');

    // 🔒 A subject with no kind is not a thing anybody can file by, so the subjects go first
    // (docs/03 §3.3.20a). Refusing says which; cascading would quietly take forty rows with it.
    const inUse = await this.kinds.countLivingSubjects(id);
    if (inUse > 0) {
      throw new ConflictError(
        'SUBJECT_KIND_IN_USE',
        `This kind still holds ${inUse} thing${inUse === 1 ? '' : 's'}`,
      );
    }

    await this.kinds.softDelete(id, this.clock.now());
  }
}
