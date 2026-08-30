import type {
  CreateSubjectKindRequest,
  ListSubjectKindsQuery,
  ListSubjectKindsResponse,
  SubjectKindDto,
  UpdateSubjectKindRequest,
} from '../../../shared/contracts/subject-kinds';
import { MAX_LIVING_SUBJECT_KINDS } from '../../domain/entities/subject-kind';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors/domain-error';
import type {
  SubjectKindListRow,
  SubjectKindRepository,
} from '../../domain/repositories/subject-kind.repository';
import { lastDocumentAtIso } from '../catalogues/catalogue-rows';
import type { Clock } from '../ports/clock';

export function toSubjectKindDto(row: SubjectKindListRow): SubjectKindDto {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    subjectCount: row.subjectCount,
    documentCount: row.documentCount,
    lastDocumentAt: lastDocumentAtIso(row.lastDocumentAt),
  };
}

// The same access shape as people and subjects (docs/03 §3.3.19–20a): reading and adding are open,
// because the analysis adds kinds on its own and whoever corrects it must be able to; renaming and
// removing are an admin's, since both reach across every thing filed under that kind.
export class ListSubjectKinds {
  constructor(private readonly kinds: SubjectKindRepository) {}

  // One page at a time (docs/07 §7.1, SEC-56), in the asked-for order — `things` admitted here too
  // (docs/07 §7.3).
  async execute(query: ListSubjectKindsQuery): Promise<ListSubjectKindsResponse> {
    const page = await this.kinds.listPage(query);
    return { items: page.items.map(toSubjectKindDto), nextCursor: page.nextCursor };
  }
}

// One row, asked for by id (docs/07 §7.3), for the reason the two other catalogues have
// (docs/11 §11.4).
export class GetSubjectKind {
  constructor(private readonly kinds: SubjectKindRepository) {}

  async execute(id: string): Promise<SubjectKindDto> {
    const row = await this.kinds.findListRow(id);
    if (row === null) throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');
    return toSubjectKindDto(row);
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

    // 🔒 The instance ceiling behind the throttle (docs/08 §8.4, SEC-51, SEC-56): a rate bounds how
    // fast a namespace fills, only a count bounds whether it can. Asked after the duplicate check,
    // because a caller whose kind already lives is better told so than told the list is full.
    if ((await this.kinds.countActive()) >= MAX_LIVING_SUBJECT_KINDS) {
      throw new UnprocessableError(
        'CATALOGUE_FULL',
        `The kinds catalogue already holds ${MAX_LIVING_SUBJECT_KINDS} living rows`,
      );
    }

    const created = await this.kinds.create({ name: input.name, note: input.note ?? null });
    // A fresh shelf: nothing filed under it yet, so every answer is the empty one.
    return {
      id: created.id,
      name: created.name,
      note: created.note,
      subjectCount: 0,
      documentCount: 0,
      lastDocumentAt: null,
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
    // One row on the list's own terms, rather than the whole catalogue for one count.
    const row = await this.kinds.findListRow(id);
    return toSubjectKindDto(
      row ?? { ...updated, subjectCount: 0, documentCount: 0, lastDocumentAt: null },
    );
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
