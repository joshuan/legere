import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Person } from '../entities/person';

export type PersonWithCount = Person & { documentCount: number };

export abstract class PersonRepository {
  abstract listActive(tx?: TransactionHandle): Promise<PersonWithCount[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<Person | null>;

  abstract findByIds(ids: string[], tx?: TransactionHandle): Promise<Person[]>;

  // Case-insensitive, because "evgenii shershnev" and "Evgenii Shershnev" are one person and the
  // analyst does not know which spelling the catalogue already has (docs/05 §5.5 step 4).
  abstract findByName(name: string, tx?: TransactionHandle): Promise<Person | null>;

  abstract create(
    input: { name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Person>;

  abstract update(
    id: string,
    input: { name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Person>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // The people on one document, in catalogue order.
  abstract listForDocument(documentId: string, tx?: TransactionHandle): Promise<Person[]>;

  // Replaces the whole set: the form sends what the document should end up with, not a diff.
  abstract setForDocument(
    documentId: string,
    personIds: string[],
    tx?: TransactionHandle,
  ): Promise<void>;
}
