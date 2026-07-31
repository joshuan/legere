import type { Availability, DocumentStep } from '../../../shared/contracts/documents';
import type {
  CategorySource,
  DocumentSource,
  FileRefStatus,
  StepStatus,
  UserRole,
} from '../../../shared/contracts/enums';
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

// Documents by pipeline step and status, for the admin overview (docs/05 §5.8).
export type StepStatusCounters = {
  total: number;
  steps: Record<DocumentStep, Record<StepStatus, number>>;
};

// Who is asking. Access is decided in SQL rather than after the fact, so a page of 30 is 30 the
// caller may read — not 30 rows filtered down to 4 (docs/03 §3.4).
export type Viewer = {
  id: string;
  role: UserRole;
};

export type DocumentCategory = {
  id: string;
  slug: string;
  name: string;
};

// A document plus what the list DTO needs and the row itself does not carry (docs/07 §7.3).
export type DocumentListItem = {
  document: Document;
  category: DocumentCategory | null;
  availability: Availability;
};

export type DocumentFileRefView = {
  libraryId: string;
  libraryName: string;
  path: string;
  status: FileRefStatus;
};

export type DocumentDetail = DocumentListItem & {
  // Only refs in libraries the viewer may see; an admin sees them all (docs/07 §7.3).
  fileRefs: DocumentFileRefView[];
  createdBy: { id: string; displayName: string } | null;
};

export type ListDocumentsInput = {
  limit: number;
  cursor?: string | undefined;
  libraryId?: string | undefined;
  categoryId?: string | undefined;
  availability?: Availability | undefined;
  processing?: boolean | undefined;
  source?: DocumentSource | undefined;
};

export type DocumentPage = {
  items: DocumentListItem[];
  nextCursor: string | null;
};

export type UpdateDocumentMetaInput = {
  title?: string;
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

  abstract countByStepStatus(tx?: TransactionHandle): Promise<StepStatusCounters>;

  // The read model, newest first, filtered by what the viewer may read (docs/03 §3.4).
  abstract listReadable(
    viewer: Viewer,
    query: ListDocumentsInput,
    tx?: TransactionHandle,
  ): Promise<DocumentPage>;

  // Null when the document does not exist, is soft-deleted, or is one this viewer may not read —
  // 🔒 the three are deliberately indistinguishable from outside (docs/08 §8.5).
  // Documents whose files sit *directly* in one folder of a library, by title (docs/07 §7.3).
  // Access is settled by the caller having been granted the library itself.
  abstract listInFolder(
    libraryId: string,
    folder: string,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<DocumentPage>;

  abstract findReadableById(
    id: string,
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<DocumentDetail | null>;

  abstract updateMeta(
    id: string,
    input: UpdateDocumentMetaInput,
    tx?: TransactionHandle,
  ): Promise<Document>;

  // Soft delete (ADR-015): the row stays, and every route stops finding it.
  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

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
