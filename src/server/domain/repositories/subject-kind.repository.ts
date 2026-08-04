import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { SubjectKind } from '../entities/subject-kind';

// A kind is worth keeping for what hangs off it, so both counts travel with it: how many things of
// this kind exist, and how many documents they are on between them (docs/03 §3.3.20a).
export type SubjectKindWithCounts = SubjectKind & {
  subjectCount: number;
  documentCount: number;
};

export abstract class SubjectKindRepository {
  abstract listActive(tx?: TransactionHandle): Promise<SubjectKindWithCounts[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<SubjectKind | null>;

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
