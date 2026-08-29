import type { Crop, Rotation } from '../../../shared/contracts/documents';
import type {
  FileOrigin,
  FileRefStatus,
  TrashReason,
  ValueSource,
} from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { DocumentPage } from '../entities/document-page';
import type { File } from '../entities/file';

export type CreateFileInput = {
  // 🔒 Given only by a caller that has to know the id **before** the row exists, which is one caller:
  // an upload writes its bytes under `files/{id}/…` before opening the transaction, so that the
  // pipeline the transaction enqueues cannot reach the bucket before them (docs/09 §9.2). The row
  // must then carry that same id, or the orphan sweep would read the key, find no file with it, and
  // delete a live original. Absent everywhere else: the database is a better source of ids than we
  // are, and a caller inventing one is a caller with something to explain.
  id?: string | undefined;
  contentHash: string;
  origin: FileOrigin;
  storageKey: string | null;
  mimeType: string;
  ext: string;
  sizeBytes: bigint;
  name: string;
};

// A file as one document reads it: where it stands among that document's files — the place of its
// first page — and the pages of it this document holds, in the order it holds them (docs/03
// §3.3.17). What a file says about a document is read off those pages and nothing else (ADR-025).
export type DocumentFile = File & { position: number; pages: DocumentPage[] };

// One page of a document with the file its bytes come from, which is what the canonical build reads:
// a list of these, in order, is the document (docs/05 §5.5 step 1).
export type DocumentPageWithFile = DocumentPage & { file: File };

// A page as it is written down: the entries of a document are rewritten wholesale, and an entry that
// was already there keeps its id so that nothing addressing it is invalidated by a rebuild.
export type DocumentPageInput = {
  id?: string | undefined;
  fileId: string;
  pageIndex: number | null;
  turn: Rotation | null;
  crop: Crop | null;
  cropSource: ValueSource;
};

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

  // How many pages the canonical build just counted in this file (docs/05 §5.5 step 1). Written on
  // every build that opens it, because that is the only moment anything knows, and it is what an
  // edit checks a page index against without asking Stirling itself.
  abstract recordPageCount(id: string, pageCount: number, tx?: TransactionHandle): Promise<void>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Deleted outright, bytes and all: emptying the trash, and nothing else (docs/05 §5.7a). Called
  // after the document that held them is gone — `document_pages` is cascaded away with it, and until
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

  // The pages of a document, in order, each with the file it is read from — what the canonical build
  // reads and what every derivation about a file in this document is computed from (ADR-025).
  abstract listPagesForDocument(
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<DocumentPageWithFile[]>;

  // The whole list, rewritten. Position is unique per document, so shifting rows one at a time
  // collides with itself halfway through; this is the only rewrite that cannot (docs/03 §3.3.17).
  //
  // 🔒 `expecting` is the reading the new list was computed from — the entries the caller was shown,
  // in order — and the rewrite happens only if that is still the document's list. Anything else is
  // `DOCUMENT_CHANGED` with nothing written, because a rewrite against a stale reading carries the
  // stale list back with it (docs/03 §3.3.17, docs/05 §5.6). `null` is the deliberate exception: the
  // caller read the list itself, inside this transaction, under the same lock this write takes.
  abstract replacePages(
    documentId: string,
    input: { pages: readonly DocumentPageInput[]; expecting: readonly DocumentPageInput[] | null },
    tx?: TransactionHandle,
  ): Promise<void>;

  // Entries put after whatever the document holds **at the moment they are written**, which is why
  // this one needs no precondition: appending cannot lose anything, so the several files an upload
  // panel sends at once do not collide (docs/03 §3.3.17). The caller says what the entries are —
  // their pages, their turns and their crops — so nothing here re-derives a page list from a file.
  abstract appendPages(
    documentId: string,
    pages: readonly DocumentPageInput[],
    tx?: TransactionHandle,
  ): Promise<void>;

  // The list as it stands, with the document held for the rest of the transaction: what a writer
  // reads when it needs the truth rather than the reading a caller was shown (docs/03 §3.3.17).
  abstract lockPagesForDocument(
    documentId: string,
    tx: TransactionHandle,
  ): Promise<DocumentPageWithFile[]>;

  // 🔒 The end of the one two-level state (ADR-025), done as a read-modify-write of its own: the
  // entries standing for a whole file become one entry per page now that a build has counted them.
  // The build spends minutes in Stirling before it gets here, so the list is re-read inside this
  // call and only the entries being expanded are touched — an arrangement made in that window is
  // somebody's work and is not overwritten by a snapshot from before the files were opened
  // (docs/05 §5.5 step 1). Answers with the list as it stands afterwards.
  abstract expandWholeFileEntries(
    documentId: string,
    pageCounts: ReadonlyMap<string, number>,
    tx?: TransactionHandle,
  ): Promise<DocumentPageWithFile[]>;

  // The files of a document, in the order its pages first name them, each carrying the pages it is
  // read as here.
  abstract listForDocument(documentId: string, tx?: TransactionHandle): Promise<DocumentFile[]>;

  // The same, for many documents at once — the list screen needs a count and a first extension per
  // row, and one query per document would be one query per document.
  abstract listForDocuments(
    documentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, DocumentFile[]>>;

  // A document this file has a live page in, or null when no document reads it (a ref whose document
  // was deleted, a file in the trash). Since ADR-025 there may be several; the answer is one of them,
  // because every caller is asking "does anything read this at all" (docs/05 §5.3).
  abstract findDocumentIdForFile(fileId: string, tx?: TransactionHandle): Promise<string | null>;

  // And **all** of them, in a stable order — what a replacement has to rewrite, since it replaces
  // the bytes for every page that reads them wherever that page is read (ADR-025, docs/05 §5.6).
  abstract listDocumentIdsForFile(fileId: string, tx?: TransactionHandle): Promise<string[]>;

  // Which of these files no live page names any more — the files that go to the trash (docs/05
  // §5.7a). Asked after the pages are gone, because that is when the question has an answer.
  abstract filterFilesWithoutLivePages(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<string[]>;

  // `attach`, `detach` and `reorder` were here until this release and are deliberately gone. All
  // three spoke the model ADR-025 retired — a file joining a document *whole*, carrying its own crop
  // and turn, living in exactly one home — and none of that is what any caller means any more:
  // `attach` re-derived a file's pages from its page count (losing the crops, the turns and the pages
  // a split had cut away), refused a file a second document already read (the invariant ADR-025
  // retired in so many words), and `reorder` regrouped a document's pages into blocks of one file
  // each, which sends a photograph inserted between pages two and three to the end. What replaced
  // them is `replacePages` and `appendPages` above, which take **entries**: the caller says what the
  // pages are, so nothing here invents them.

  // How many live library refs each of these files has, so availability can be answered for a whole
  // list in one query (docs/03 §3.3.10).
  abstract countLiveRefsForFiles(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, number>>;
}
