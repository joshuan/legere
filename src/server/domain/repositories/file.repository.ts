import type { Crop } from '../../../shared/contracts/documents';
import type {
  FileOrigin,
  FileRefStatus,
  TrashReason,
  ValueSource,
} from '../../../shared/contracts/enums';
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

// Where a file's bytes were seen on a volume — the same answer whether the file is part of a
// document or in the trash, so it is one type (docs/07 §7.3).
export type FileRefView = {
  libraryId: string;
  libraryName: string;
  path: string;
  status: FileRefStatus;
};

// A file in the trash, as the screen that lists it needs it (docs/11 §11.13b): where its bytes are,
// and whether they can still be read at all.
export type TrashedFile = File & {
  available: boolean;
  refs: FileRefView[];
};

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

  // Deleted outright, bytes and all: emptying the trash, and nothing else (docs/05 §5.7a). Called
  // after the document that held them is gone — `document_files` is cascaded away with it, and until
  // it is these rows are still referenced.
  abstract hardDelete(ids: readonly string[], tx?: TransactionHandle): Promise<void>;

  // --- the trash (docs/05 §5.7a) --------------------------------------------------------------

  // Into the trash: the file leaves its document without being destroyed. `replacedById` is set only
  // for REPLACED, and it re-points the earlier versions of the same page too — every copy points at
  // the file that is in the document now, so listing the versions of a page stays one query.
  abstract trash(
    input: {
      fileIds: readonly string[];
      reason: TrashReason;
      trashedFrom: string | null;
      replacedById?: string | undefined;
      at: Date;
    },
    tx?: TransactionHandle,
  ): Promise<void>;

  // Back out of it, because these bytes are wanted again: the caller gives the file a document
  // (a new one, docs/05 §5.7a) and this clears what the trash wrote.
  abstract untrash(id: string, tx?: TransactionHandle): Promise<File>;

  // The earlier copies of these pages, newest first — what the viewer shows under a file that has
  // been replaced (docs/07 §7.3), keyed by the file that replaced them.
  abstract listVersionsFor(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, File[]>>;

  // The trash itself, newest first, with what the whole of it holds — the page is what is read and
  // the total is why the screen is opened (docs/07 §7.3).
  abstract listTrashed(
    query: { limit: number; cursor?: Date | undefined },
    tx?: TransactionHandle,
  ): Promise<{ items: TrashedFile[]; totalItems: number; totalBytes: bigint }>;

  // Everything in the trash, for emptying it; and the part of it the sweep may take (docs/09 §9.2) —
  // ours, and old enough. A LIBRARY file is never in that second answer, whatever its age.
  abstract listAllTrashed(tx?: TransactionHandle): Promise<File[]>;
  abstract listPurgeable(before: Date, limit: number, tx?: TransactionHandle): Promise<File[]>;

  // Which of these ids exist as rows at all: the same question maintenance asks about documents,
  // asked about files, so an object under `files/{id}/` whose row is gone can be swept (docs/09 §9.2).
  abstract filterExistingIds(ids: string[], tx?: TransactionHandle): Promise<string[]>;

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
