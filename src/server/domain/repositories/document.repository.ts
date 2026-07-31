import type { CategorySource, DocumentSource } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Document, DocumentSteps } from '../entities/document';

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

// What the pipeline writes back as it goes (docs/05 §5.5). Every field is optional: a step records
// its own outcome and nothing else, so progress is visible while the rest of the run continues.
export type ProcessingUpdate = {
  steps?: Partial<DocumentSteps>;
  pageCount?: number | null;
  markdown?: string | null;
  ocrUsed?: boolean;
  processingError?: string | null;
  failedStep?: string | null;
  categoryId?: string | null;
  categorySource?: CategorySource;
};

export abstract class DocumentRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<Document | null>;

  // Records the outcome of a pipeline step. Not part of a transaction with the artifact write: S3 has
  // none, and the DB status is what is authoritative either way (docs/09 §9.2).
  abstract updateProcessing(
    id: string,
    update: ProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Document>;

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
