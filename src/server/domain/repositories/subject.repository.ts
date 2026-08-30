import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Subject } from '../entities/subject';
import type { CataloguePage, CataloguePageQuery } from './person.repository';

export type SubjectWithCount = Subject & { documentCount: number };

// A row as the list answers it (docs/07 §7.3): the count, and the newest `documentDate` among the
// living documents about this thing — `null` when none carries a date.
export type SubjectListRow = SubjectWithCount & { lastDocumentAt: Date | null };

export abstract class SubjectRepository {
  abstract listActive(tx?: TransactionHandle): Promise<SubjectWithCount[]>;

  // One page in the asked-for order (docs/07 §7.1, SEC-56), on the people repository's terms; the
  // whole catalogue stays `listActive`'s.
  abstract listPage(query: CataloguePageQuery): Promise<CataloguePage<SubjectListRow>>;

  // One row on the list's own terms, for the answers a create, an update or a merge owes
  // (docs/07 §7.3). Living rows only.
  abstract findListRow(id: string, tx?: TransactionHandle): Promise<SubjectListRow | null>;

  // How many living rows the catalogue holds — what every create measures against the instance
  // ceiling (docs/08 §8.4, SEC-56).
  abstract countActive(tx?: TransactionHandle): Promise<number>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<Subject | null>;

  // Living rows only, as for people: what comes back is what may still be chosen, so a caller can
  // tell a name it may name a document with from one it may not (docs/03 §3.3.20).
  abstract findByIds(ids: string[], tx?: TransactionHandle): Promise<Subject[]>;

  // Case-insensitively on the name, and within one kind: the kind is part of the identity, because
  // "Montenegro" the country and "Montenegro" the boat are two things (docs/04 §4.3).
  abstract findByKindAndName(
    kindId: string,
    name: string,
    tx?: TransactionHandle,
  ): Promise<Subject | null>;

  abstract create(
    input: { kindId: string; name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject>;

  abstract update(
    id: string,
    input: { kindId?: string; name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Subject>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  abstract listForDocument(documentId: string, tx?: TransactionHandle): Promise<Subject[]>;

  // The living things filed under these kinds — what a kinds merge has to carry over
  // (docs/03 §3.3.20a).
  abstract listByKinds(kindIds: string[], tx?: TransactionHandle): Promise<Subject[]>;

  // Re-files these things under another kind, name and note untouched: a kinds merge moves shelves,
  // not labels (docs/03 §3.3.20a).
  abstract moveToKind(ids: string[], kindId: string, tx?: TransactionHandle): Promise<void>;

  // Moves every document link from these rows onto one survivor, collapsing the duplicates a
  // document that named two of them would otherwise end up with (docs/03 §3.3.20).
  abstract moveDocumentLinks(
    fromIds: string[],
    toId: string,
    tx?: TransactionHandle,
  ): Promise<void>;

  abstract setForDocument(
    documentId: string,
    subjectIds: string[],
    tx?: TransactionHandle,
  ): Promise<void>;
}
