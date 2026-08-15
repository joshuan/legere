import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { OrderedPair } from '../entities/document-link';

// One edge, seen from one of its ends (docs/03 §3.3.23). The other side travels as an id: whether
// the caller may see it is the use case's question, asked of the document repository under the
// access rule — never answered here.
export type DocumentLinkEdge = {
  otherDocumentId: string;
  linkedAt: Date;
};

export abstract class DocumentLinkRepository {
  // Newest first, from either end of the edge.
  abstract listForDocument(documentId: string, tx?: TransactionHandle): Promise<DocumentLinkEdge[]>;

  abstract exists(pair: OrderedPair, tx?: TransactionHandle): Promise<boolean>;

  abstract create(
    pair: OrderedPair,
    createdById: string | null,
    at: Date,
    tx?: TransactionHandle,
  ): Promise<void>;

  // True when there was an edge to remove — hard-deleted, like a collection item (docs/03 §3.3.23).
  abstract remove(pair: OrderedPair, tx?: TransactionHandle): Promise<boolean>;
}
