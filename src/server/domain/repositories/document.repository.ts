import type { DocumentSource } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Document } from '../entities/document';

export type CreateDocumentInput = {
  contentHash: string;
  source: DocumentSource;
  mimeType: string;
  ext: string;
  sizeBytes: bigint;
  title: string;
  createdById?: string | null;
  scanSetId?: string | null;
};

// `created` tells the caller whether it owns the document's processing: only the ingest that actually
// created it starts the pipeline (docs/05 §5.3 — dedup must not re-run processing).
export type DocumentUpsert = {
  document: Document;
  created: boolean;
};

export abstract class DocumentRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<Document | null>;

  abstract findActiveByContentHash(
    contentHash: string,
    tx?: TransactionHandle,
  ): Promise<Document | null>;

  // The deduplication primitive (ADR-009): returns the existing active document for this content, or
  // creates one. Two ingests racing on identical content both end up attached to the same document —
  // documents_content_hash_active_uq (docs/04 §4.3) decides which of them created it.
  abstract findOrCreateByContentHash(
    input: CreateDocumentInput,
    tx?: TransactionHandle,
  ): Promise<DocumentUpsert>;
}
