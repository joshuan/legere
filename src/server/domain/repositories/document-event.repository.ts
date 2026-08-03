import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { DocumentEvent, DocumentEventPayload } from '../entities/document-event';
import type { DocumentEventType } from '../../../shared/contracts/enums';

export type NewDocumentEvent = {
  documentId: string;
  type: DocumentEventType;
  actorId?: string | null;
  payload?: DocumentEventPayload;
};

export type DocumentEventView = DocumentEvent & {
  // Resolved for display; null when the pipeline did it, or when the actor has since been deleted.
  actorName: string | null;
};

export abstract class DocumentEventRepository {
  // Appending to the log must never be the reason an operation fails: a document that processed
  // correctly but could not be written about is still a processed document (docs/03 §3.3.18).
  abstract record(event: NewDocumentEvent, tx?: TransactionHandle): Promise<void>;

  // Newest first, like every other list in the product (docs/07 §7.3).
  abstract listForDocument(
    documentId: string,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<{ items: DocumentEventView[]; nextCursor: string | null }>;
}
