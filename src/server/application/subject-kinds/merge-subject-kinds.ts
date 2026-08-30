import type {
  MergeSubjectKindsRequest,
  SubjectKindDto,
} from '../../../shared/contracts/subject-kinds';
import type { Subject } from '../../domain/entities/subject';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import { foldName } from '../../domain/value-objects/name-fold';
import type { Clock } from '../ports/clock';
import type { UnitOfWork } from '../ports/unit-of-work';
import { toSubjectKindDto } from './manage-subject-kinds';

// Three spellings of one shelf become one (docs/03 §3.3.20a): the oldest kind survives, takes the
// name that was chosen, and receives every subject the others held. Where two of the merged kinds
// held the same thing — one folded name on both sides — the things are folded too, because a merge
// whose result violates the `(kindId, nameFolded)` identity would be a merge that undid the
// table's own rule.
//
// One transaction, like every merge: a half-moved shelf would leave things filed under a kind
// nobody can see.
export class MergeSubjectKinds {
  constructor(
    private readonly kinds: SubjectKindRepository,
    private readonly subjects: SubjectRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(input: MergeSubjectKindsRequest): Promise<SubjectKindDto> {
    const rows = await this.kinds.findByIds(input.ids);
    if (rows.length !== input.ids.length) {
      throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');
    }

    // 🔒 The surviving name must not collide with a kind that was not part of the merge — that
    // would be two shelves becoming one by accident.
    const clash = await this.kinds.findByName(input.name);
    if (clash !== null && !input.ids.includes(clash.id)) {
      throw new ConflictError('SUBJECT_KIND_EXISTS', 'A kind with this name already exists');
    }

    const survivor = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (survivor === undefined) {
      throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');
    }
    const merged = input.ids.filter((id) => id !== survivor.id);

    const now = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      // Every living thing on any of the merged shelves, grouped by its folded name: one group is
      // one thing, however many kinds it was filed under (docs/03 §3.3.20a).
      const things = await this.subjects.listByKinds(input.ids, tx);
      const byFold = new Map<string, Subject[]>();
      for (const thing of things) {
        const fold = foldName(thing.name);
        byFold.set(fold, [...(byFold.get(fold) ?? []), thing]);
      }

      const carried: string[] = [];
      for (const twins of byFold.values()) {
        const [keeper, ...rest] = [...twins].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
        if (keeper === undefined) continue;
        if (rest.length > 0) {
          // The same collapse a subjects merge does (docs/03 §3.3.20): links move onto the oldest,
          // duplicates fold, the latecomers are soft-deleted.
          await this.subjects.moveDocumentLinks(
            rest.map((twin) => twin.id),
            keeper.id,
            tx,
          );
          for (const twin of rest) await this.subjects.softDelete(twin.id, now, tx);
        }
        if (keeper.kindId !== survivor.id) carried.push(keeper.id);
      }

      // The keepers move onto the surviving shelf; the emptied kinds go before the survivor is
      // renamed, for the same reason the people merge deletes before it renames (docs/03 §3.3.19).
      await this.subjects.moveToKind(carried, survivor.id, tx);
      for (const id of merged) await this.kinds.softDelete(id, now, tx);
      await this.kinds.update(
        survivor.id,
        { name: input.name, ...(input.note === undefined ? {} : { note: input.note }) },
        tx,
      );
    });

    const row = await this.kinds.findListRow(survivor.id);
    return toSubjectKindDto(
      row ?? {
        ...survivor,
        name: input.name,
        note: input.note ?? survivor.note,
        subjectCount: 0,
        documentCount: 0,
        lastDocumentAt: null,
      },
    );
  }
}
