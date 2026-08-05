import type { Crop } from '../../../shared/contracts/documents';
import type { FileOrigin, ValueSource } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { File } from '../entities/file';

export type CreateFileInput = {
  contentHash: string;
  origin: FileOrigin;
  storageKey: string | null;
  mimeType: string;
  ext: string;
  sizeBytes: bigint;
  name: string;
};

// A file with the place it holds in a document, which is the only thing a document orders by.
export type DocumentFile = File & { position: number };

export abstract class FileRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<File | null>;

  // Deduplication, one level down from where it used to live (ADR-009, ADR-021): the same bytes
  // arriving twice are one file, whatever brought them.
  abstract findActiveByContentHash(
    contentHash: string,
    tx?: TransactionHandle,
  ): Promise<File | null>;

  // Read-then-create with a P2002 fallback on `files_content_hash_active_uq`, so two ingests of one
  // file converge instead of racing.
  abstract findOrCreateByContentHash(
    input: CreateFileInput,
    tx?: TransactionHandle,
  ): Promise<{ file: File; created: boolean }>;

  abstract setCrop(
    id: string,
    crop: Crop | null,
    cropSource: ValueSource,
    tx?: TransactionHandle,
  ): Promise<File>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // --- the composition of a document -------------------------------------------------------

  // The files of a document, by position.
  abstract listForDocument(documentId: string, tx?: TransactionHandle): Promise<DocumentFile[]>;

  // The same, for many documents at once — the list screen needs a count and a first extension per
  // row, and one query per document would be one query per document.
  abstract listForDocuments(
    documentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, DocumentFile[]>>;

  // The document a file belongs to, or null when it belongs to none (a ref whose document was
  // deleted, a file mid-move).
  abstract findDocumentIdForFile(fileId: string, tx?: TransactionHandle): Promise<string | null>;

  // Appends at the end, keeping positions contiguous. 🔒 Fails when the file already has a home
  // (`document_files.file_id` is unique) — that is `FILE_ALREADY_IN_DOCUMENT` (docs/07 §7.2).
  abstract attach(documentId: string, fileId: string, tx?: TransactionHandle): Promise<void>;

  abstract detach(documentId: string, fileId: string, tx?: TransactionHandle): Promise<void>;

  // Rewrites positions wholesale from the given order; the caller has already checked that it is a
  // permutation of the document's own files.
  abstract reorder(
    documentId: string,
    fileIdsInOrder: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void>;

  // How many live library refs each of these files has, so availability can be answered for a whole
  // list in one query (docs/03 §3.3.10).
  abstract countLiveRefsForFiles(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, number>>;
}
