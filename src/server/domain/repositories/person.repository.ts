import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Person } from '../entities/person';

export type PersonWithCount = Person & { documentCount: number };

export type CataloguePage<T> = { items: T[]; nextCursor: string | null };

export abstract class PersonRepository {
  // The whole living catalogue, for the callers that genuinely need all of it — the analysis, the
  // merge suggesters. The API reads pages (docs/07 §7.1, SEC-56).
  abstract listActive(tx?: TransactionHandle): Promise<PersonWithCount[]>;

  // One page by name then id, keyset-cursored like every other list (docs/07 §7.1).
  abstract listPage(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<CataloguePage<PersonWithCount>>;

  // How many living rows the catalogue holds — what every create measures against the instance
  // ceiling (docs/08 §8.4, SEC-56).
  abstract countActive(tx?: TransactionHandle): Promise<number>;

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

  // Moves every document link from these rows onto one survivor, collapsing the duplicates a
  // document that named two of them would otherwise end up with (docs/03 §3.3.19). The merged-away
  // rows are not touched here — the use case soft-deletes them inside the same transaction.
  abstract moveDocumentLinks(
    fromIds: string[],
    toId: string,
    tx?: TransactionHandle,
  ): Promise<void>;

  // Replaces the whole set: the form sends what the document should end up with, not a diff.
  abstract setForDocument(
    documentId: string,
    personIds: string[],
    tx?: TransactionHandle,
  ): Promise<void>;
}
