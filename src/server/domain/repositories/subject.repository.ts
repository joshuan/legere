import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Subject } from '../entities/subject';

export type SubjectWithCount = Subject & { documentCount: number };

export abstract class SubjectRepository {
  abstract listActive(tx?: TransactionHandle): Promise<SubjectWithCount[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<Subject | null>;

  // Case-insensitively, and by both halves: the kind is part of the identity, because "Montenegro"
  // the country and "Montenegro" the boat are two things (docs/04 §4.3).
  abstract findByKindAndName(
    kind: string,
    name: string,
    tx?: TransactionHandle,
  ): Promise<Subject | null>;

  abstract create(
    input: { kind: string; name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject>;

  abstract update(
    id: string,
    input: { kind?: string; name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  abstract listForDocument(documentId: string, tx?: TransactionHandle): Promise<Subject[]>;

  abstract setForDocument(
    documentId: string,
    subjectIds: string[],
    tx?: TransactionHandle,
  ): Promise<void>;
}
