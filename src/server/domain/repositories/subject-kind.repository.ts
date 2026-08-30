import type { CatalogueOrder, SubjectKindSort } from '../../../shared/contracts/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { SubjectKind } from '../entities/subject-kind';
import type { CataloguePage } from './person.repository';

// A kind is worth keeping for what hangs off it, so both counts travel with it: how many things of
// this kind exist, and how many documents they are on between them (docs/03 §3.3.20a).
export type SubjectKindWithCounts = SubjectKind & {
  subjectCount: number;
  documentCount: number;
};

// A row as the list answers it (docs/07 §7.3): the counts, and the newest `documentDate` across
// the living documents about this kind's living things — `null` when none carries a date.
export type SubjectKindListRow = SubjectKindWithCounts & { lastDocumentAt: Date | null };

// The kinds page's question widens the sort enum by `things` (docs/07 §7.3).
export type SubjectKindPageQuery = {
  limit: number;
  cursor?: string | undefined;
  sort: SubjectKindSort;
  order: CatalogueOrder;
};

export abstract class SubjectKindRepository {
  abstract listActive(tx?: TransactionHandle): Promise<SubjectKindWithCounts[]>;

  // One page in the asked-for order (docs/07 §7.1, SEC-56), on the people repository's terms; the
  // whole catalogue stays `listActive`'s.
  abstract listPage(query: SubjectKindPageQuery): Promise<CataloguePage<SubjectKindListRow>>;

  // One row on the list's own terms, for the answers a create, an update or a merge owes
  // (docs/07 §7.3). Living rows only.
  abstract findListRow(id: string, tx?: TransactionHandle): Promise<SubjectKindListRow | null>;

  // How many living rows the catalogue holds — what every create measures against the instance
  // ceiling (docs/08 §8.4, SEC-51, SEC-56).
  abstract countActive(tx?: TransactionHandle): Promise<number>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<SubjectKind | null>;

  // Living rows only, the way people answer it (docs/03 §3.3.19): what comes back is what may
  // still be merged.
  abstract findByIds(ids: string[], tx?: TransactionHandle): Promise<SubjectKind[]>;

  // Case-insensitively: "Apartment" and "apartment" are one kind, and the analysis does not know
  // which spelling the catalogue already has (docs/05 §5.5 step 4).
  abstract findByName(name: string, tx?: TransactionHandle): Promise<SubjectKind | null>;

  abstract create(
    input: { name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<SubjectKind>;

  abstract update(
    id: string,
    input: { name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<SubjectKind>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // 🔒 Whether anything living still files under this kind. A subject with no kind is not a thing
  // anybody can file by, so a kind in use is not removable (docs/03 §3.3.20a).
  abstract countLivingSubjects(id: string, tx?: TransactionHandle): Promise<number>;
}
