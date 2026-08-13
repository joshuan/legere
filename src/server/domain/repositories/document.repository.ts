import type {
  AutoValues,
  Availability,
  DocumentGroupBy,
  DocumentSort,
  DocumentStep,
} from '../../../shared/contracts/documents';
import type {
  PageFormat,
  ValueSource,
  FileOrigin,
  FileRefStatus,
  StepSkipReason,
  StepStatus,
  UserRole,
} from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Document, DocumentSteps } from '../entities/document';
import type { DocumentFile } from './file.repository';

// A document is created empty and given its files afterwards (docs/03 §3.3.17): what the bytes are
// is a property of a file now, and deduplication happens one level down (ADR-021).
export type CreateDocumentInput = {
  title: string;
  createdById?: string | null;
};

// What the pipeline writes back as it goes (docs/05 §5.5). Every field is optional: a step records
// its own outcome and nothing else, so progress is visible while the rest of the run continues.
export type ProcessingUpdate = {
  steps?: Partial<DocumentSteps>;
  // What this step produced or spent, for the entry that settles it (docs/03 §3.3.18). Not columns
  // on the document: they belong to one run of one step, and the journal is where a run lives.
  metrics?: StepMetrics;
  // Merged into what is already there, one step at a time — the pipeline settles steps separately
  // (docs/03 §3.3.10). Setting a step's reason to null clears it, which is what a re-run does.
  skipReasons?: Partial<Record<keyof DocumentSteps, StepSkipReason | null>>;
  pageCount?: number | null;
  languages?: string[];
  country?: string | null;
  city?: string | null;
  // Merged into what is already recorded, one step at a time: the parse contributes the languages
  // it detected, the AI step the rest (docs/03 §3.3.10).
  auto?: AutoValues;
  documentDate?: string | null;
  markdown?: string | null;
  ocrUsed?: boolean;
  processingError?: string | null;
  failedStep?: string | null;
  typeId?: string | null;
  typeSource?: ValueSource;
  title?: string;
  titleSource?: ValueSource;
  description?: string | null;
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

// A name a document carries and the row it came from (docs/03 §3.3.19–3.3.20).
export type DocumentName = { id: string; name: string };

// A document plus what the list DTO needs and the row itself does not carry (docs/07 §7.3): all of
// it derived from the files the document holds, none of it stored (docs/03 §3.3.10) — except the
// names, which are links of their own.
export type DocumentListItem = {
  document: Document;
  documentType: DocumentCategory | null;
  fileCount: number;
  // The extension of the first file — what the card puts on its badge. Empty when it has none.
  primaryExt: string;
  // What the files weigh together.
  sizeBytes: bigint;
  origin: FileOrigin;
  availability: Availability;
  // Who and what the document is about, for the card that may show either (docs/11 §11.3). Read for
  // a whole page at once, like the files above, and never one query per row.
  people: DocumentName[];
  subjects: DocumentName[];
};

export type DocumentFileRefView = {
  libraryId: string;
  libraryName: string;
  path: string;
  status: FileRefStatus;
};

// One file of a document, in its place, with where its bytes can be found (docs/07 §7.3).
export type DocumentFileView = DocumentFile & {
  // Whether these bytes can be read right now — false for a library file whose volume lost it.
  available: boolean;
  // 🔒 Only refs in libraries the viewer may see; an admin sees them all. Always empty for a
  // managed file, whose bytes are in the bucket rather than on a volume.
  refs: DocumentFileRefView[];
};

export type DocumentDetail = {
  document: Document;
  documentType: DocumentCategory | null;
  // Who the document is about (docs/03 §3.3.19).
  people: Array<{ id: string; name: string; deleted: boolean }>;
  // And what it is about (docs/03 §3.3.20). The kind is a row of its own (§3.3.20a), so it travels
  // by id as well as by name.
  subjects: Array<{
    id: string;
    kindId: string;
    kind: string;
    name: string;
    deleted: boolean;
  }>;
  // What it is made of, by position (docs/03 §3.3.17). Everything a list row derives — the count,
  // the first extension, the weight, the origin, the availability — is derivable from this.
  files: DocumentFileView[];
  createdBy: { id: string; displayName: string } | null;
};

// What narrows a list, and — unchanged, because a shelf and its groups must agree — what narrows a
// count per group (docs/07 §7.3).
export type DocumentFilterInput = {
  libraryId?: string | undefined;
  typeId?: string | undefined;
  availability?: Availability | undefined;
  processing?: boolean | undefined;
  // LIBRARY selects documents holding at least one file on a volume, MANAGED the rest (docs/07 §7.3).
  origin?: FileOrigin | undefined;
  personId?: string | undefined;
  subjectId?: string | undefined;
  // Every subject of one kind at once, rather than one named thing (docs/03 §3.3.20a).
  subjectKindId?: string | undefined;
  year?: number | undefined;
  // The documents one dimension cannot place: no type, no date, nobody named on them
  // (docs/11 §11.3).
  unassigned?: DocumentGroupBy | undefined;
  // Where the document is from: the country code as stored (upper-case, ISO 3166-1 alpha-2) and the
  // city exactly as the document writes it (docs/03 §3.3.10).
  country?: string | undefined;
  city?: string | undefined;
  // A pipeline step and the status it sits in, which are one filter and not two: what a queue
  // counter links to (docs/07 §7.3, docs/11 §11.13). Half of it is refused before it reaches here,
  // and half of it here filters nothing.
  step?: DocumentStep | undefined;
  stepStatus?: StepStatus | undefined;
};

export type ListDocumentsInput = DocumentFilterInput & {
  limit: number;
  cursor?: string | undefined;
  // Which of the named orders of docs/07 §7.1 to read the shelf in. Absent means the default — the
  // date on the document — because a repository is asked the same question by callers that never
  // saw a query string.
  sort?: DocumentSort | undefined;
};

// One shelf of a dimension: the value to filter by, what to call it, and how many documents of the
// filtered archive are on it (docs/07 §7.3). Unordered — which shelf comes first is the answer's
// shape, not the query's, and is decided one layer up.
export type DocumentGroupCount = {
  // `null` is the group of everything this dimension cannot place (docs/11 §11.3).
  key: string | null;
  label: string;
  count: number;
};

export type DocumentPage = {
  items: DocumentListItem[];
  nextCursor: string | null;
};

export type UpdateDocumentMetaInput = {
  title?: string;
  titleSource?: ValueSource;
  description?: string | null;
  documentDate?: string | null;
  languages?: string[];
  country?: string | null;
  city?: string | null;
  typeId?: string | null;
  typeSource?: ValueSource;
  pageFormat?: PageFormat;
};

// The numbers a step can answer with. Every one of them is a question somebody asks of a document
// that came out wrong: how long did it take, how much did it cost, and did it actually read anything
// (docs/03 §3.3.18).
export type StepMetrics = {
  // Characters of text the step produced — the half of "it took four minutes" that says whether the
  // four minutes bought anything.
  chars?: number;
  // Pages it worked over, and whether recognition had to be run at all.
  pages?: number;
  ocrUsed?: boolean;
  // What a model reported spending. Read from the provider's own accounting rather than counted
  // here, because only it knows what its tokenizer did.
  promptTokens?: number;
  completionTokens?: number;
  // Which engine produced the text of this step. Two of them write the same field now, and "which
  // one wrote this" is the first question anybody asks of a bad result (docs/05 §5.5 step 3).
  transcribed?: boolean;
};

// One row of a search result before it becomes a DTO (docs/07 §7.3).
export type SearchMatch = {
  item: DocumentListItem;
  // Rank of this document within one ordering, 1-based; the fusion in the use case needs the
  // position, not the engine's own score.
  rank: number;
  snippet: string | null;
};

export type SearchFilters = {
  libraryId?: string | undefined;
  typeId?: string | undefined;
};

export abstract class DocumentRepository {
  abstract findById(id: string, tx?: TransactionHandle): Promise<Document | null>;

  // A document with nothing in it yet: the files are attached afterwards, in order (docs/03 §3.3.17).
  // There is no upsert-by-content here any more — the same bytes arriving twice are one *file*, and
  // whether that file already has a document is what the ingest asks next (docs/05 §5.3).
  abstract create(input: CreateDocumentInput, tx?: TransactionHandle): Promise<Document>;

  // Records the outcome of a pipeline step. Not part of a transaction with the artifact write: S3 has
  // none, and the DB status is what is authoritative either way (docs/09 §9.2).
  abstract updateProcessing(
    id: string,
    update: ProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Document>;

  abstract countByStepStatus(tx?: TransactionHandle): Promise<StepStatusCounters>;

  // Documents left waiting: a step is PENDING and nothing has written to the row since `olderThan`.
  // A document being processed right now has its steps written as they run, so it is never in this
  // answer — what is, is a document whose job was lost or was never enqueued at all, which is what a
  // migration that resets statuses leaves behind (docs/05 §5.4).
  // Every step of this document that nothing is scheduled for becomes QUEUED, because the caller has
  // just scheduled it (docs/03 §3.3.10). Only PENDING moves: a step that is DONE, FAILED or SKIPPED
  // has an outcome, and the run about to happen may or may not touch it.
  abstract markUnstartedQueued(documentId: string, tx?: TransactionHandle): Promise<void>;

  abstract listStaleUnstartedIds(
    olderThan: Date,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<string[]>;

  // The documents whose named step sits in a given status, newest first — what "the previews failed,
  // run them again" needs to find (docs/07 §7.3). Bounded by the caller: a repair on a large archive
  // is meant to drain in batches, not in one push. Soft-deleted documents are not part of it.
  // Documents to run again, newest first. An absent step or status is "any of them" — the widening
  // question of docs/11 §11.13, asked in one place so the SQL says it once.
  abstract listIdsByStepStatus(
    step: DocumentStep | undefined,
    status: StepStatus | undefined,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<string[]>;

  // 🔒 Only the years this viewer can see documents in: a year with one document they may not read
  // is not a year that exists for them (docs/03 §3.4).
  abstract listYears(
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<Array<{ year: number; count: number }>>;

  // How many documents each shelf of one dimension holds, under the same filters the list is being
  // read through (docs/07 §7.3). A document on several shelves — two people — is counted on each.
  //
  // 🔒 Counted under the access rule, exactly as the list is: a count is a statement about the
  // archive, and a group whose only document this viewer may not read is not a group that exists
  // for them (docs/03 §3.4).
  abstract countByGroup(
    viewer: Viewer,
    by: DocumentGroupBy,
    filters: DocumentFilterInput,
    tx?: TransactionHandle,
  ): Promise<DocumentGroupCount[]>;

  // The read model, in one of the named orders of docs/07 §7.1, filtered by what the viewer may
  // read (docs/03 §3.4). 🔒 A cursor carries the order it was cut from; one that disagrees with the
  // requested `sort` is refused rather than answered from the wrong column.
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

  // Full-text search over title + markdown (docs/04 §4.3): the generated tsvector, queried with
  // websearch_to_tsquery and snippeted with ts_headline. 🔒 The access rule is part of the query.
  abstract searchByText(
    viewer: Viewer,
    query: string,
    filters: SearchFilters,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<SearchMatch[]>;

  // Nearest chunks by cosine distance, grouped to their documents — the best chunk wins and its
  // text becomes the snippet (docs/07 §7.3).
  abstract searchByVector(
    viewer: Viewer,
    embedding: number[],
    filters: SearchFilters,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<SearchMatch[]>;

  // The items of a collection this viewer may read (docs/03 §3.3.14): the same access rule as
  // everywhere else, which is what makes a shared document readable to somebody who can see none of
  // the libraries it might sit in.
  abstract listInCollection(
    collectionId: string,
    viewer: Viewer,
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

  // Soft delete (ADR-015): the row stays, and every route stops finding it. What a document absorbed
  // into another gets (docs/05 §5.6) — its files moved, so the row is a record of where they came
  // from.
  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;

  // 🔒 The real one, and the one exception ADR-015 makes (docs/03 §3.3.10): the row goes, and the
  // journal, chunks, links and `document_files` go with it through the cascades of docs/04 §4.2.
  // What is *not* here is deliberate — the collection items, the file rows and the objects in the
  // bucket are deleted by the caller, in that order, because each is somebody else's table and the
  // order is what keeps the foreign keys satisfied.
  abstract hardDelete(id: string, tx?: TransactionHandle): Promise<void>;

  // Which of these ids exist as rows at all — soft-deleted ones included, because their artifacts
  // are deliberately retained (docs/09 §9.2). Maintenance uses it to tell an orphaned S3 object
  // from one that still belongs to a document.
  abstract filterExistingIds(ids: string[], tx?: TransactionHandle): Promise<string[]>;
}
