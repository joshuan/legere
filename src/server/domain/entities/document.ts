import {
  DOCUMENT_STEPS,
  type AutoValues,
  type Availability,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import type {
  PageFormat,
  ValueSource,
  FileOrigin,
  StepSkipReason,
  StepStatus,
  UserRole,
} from '../../../shared/contracts/enums';

// Document entity (docs/03 §3.3.10): what a person reads — an ordered list of files (§3.3.16,
// §3.3.17) plus one canonical PDF built from them. The bytes themselves belong to the files, so
// nothing here says what the document is made of; that is asked of the FileRepository.
// Pipeline step statuses live on the row so progress is visible in the admin panel (docs/05 §5.5).
export type DocumentSteps = {
  canonical: StepStatus;
  preview: StepStatus;
  markdown: StepStatus;
  analysis: StepStatus;
  vectorization: StepStatus;
};

// Keyed by the step names of DocumentSteps; a step that ran carries no entry.
export type SkipReasons = Partial<Record<keyof DocumentSteps, StepSkipReason>>;

export type Document = {
  id: string;
  // Pages of the canonical PDF; null until it has been built (docs/03 §3.3.10).
  pageCount: number | null;
  title: string;
  // What this document is, for somebody who has never seen it (docs/03 §3.3.10).
  description: string | null;
  // Who called it that: nobody (the file name), the analysis, or a person (docs/03 §3.3.10).
  // The shape its pages are filed under; AUTO until somebody decides otherwise (docs/05 §5.5 step 1).
  pageFormat: PageFormat;
  titleSource: ValueSource;
  // The extracted Markdown representation (docs/03 §3.3.10); null until step 3 has run, and also
  // when the step ran and found no text at all.
  markdown: string | null;
  steps: DocumentSteps;
  processingError: string | null;
  // Why each SKIPPED step was skipped (docs/03 §3.3.10); a step that ran has no entry.
  skipReasons: SkipReasons;
  // BCP-47 tags, most likely first; empty when there was too little text to tell (docs/03 §3.3.10).
  languages: string[];
  // What the pipeline decided, before anybody corrected it (docs/03 §3.3.10).
  auto: AutoValues;
  // The date written on the document — signed, issued, departed — as yyyy-mm-dd. Not a timestamp:
  // a signing has no clock.
  documentDate: string | null;
  // Where the document belongs: ISO 3166-1 alpha-2, and the city as it is written (docs/03 §3.3.10).
  country: string | null;
  city: string | null;
  failedStep: string | null;
  ocrUsed: boolean;
  typeId: string | null;
  typeSource: ValueSource;
  createdById: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

// Whether the bytes behind one file can be read right now (docs/03 §3.3.10). A MANAGED file always
// can — the bucket is ours and does not go missing behind our back — so only library files move
// this needle, and they move it while at least one live ref still points at them.
export function isFileReadable(origin: FileOrigin, liveRefsInActiveLibraries: number): boolean {
  return origin === 'MANAGED' || liveRefsInActiveLibraries > 0;
}

// Derived, never stored (docs/03 §3.3.10). AVAILABLE when every file of the document can be read,
// PARTIAL when some can and some cannot, UNAVAILABLE when none can — which is also the answer for a
// document with no files at all, since there is nothing left to read. The canonical PDF outlives all
// of them either way: an unavailable document still reads, searches and downloads as a PDF.
export function availabilityOf(readablePerFile: readonly boolean[]): Availability {
  if (readablePerFile.length === 0) return 'UNAVAILABLE';
  if (readablePerFile.every((readable) => readable)) return 'AVAILABLE';
  if (readablePerFile.some((readable) => readable)) return 'PARTIAL';
  return 'UNAVAILABLE';
}

// Derived, never stored (docs/03 §3.3.10): a document is LIBRARY as soon as one of its files sits on
// a volume — absorbing an upload does not change what a document is, it gains a file. A document
// with no files is MANAGED, because nothing of it is on anybody's volume.
export function originOf(fileOrigins: readonly FileOrigin[]): FileOrigin {
  return fileOrigins.includes('LIBRARY') ? 'LIBRARY' : 'MANAGED';
}

// True while any step still has work to do and nothing it depends on has failed (docs/03 §3.3.10).
export function isProcessing(steps: DocumentSteps): boolean {
  return Object.values(steps).some(
    (status) => status === 'PENDING' || status === 'QUEUED' || status === 'RUNNING',
  );
}

// 🔒 Whether a run asked for `requested` may wipe `processingError` and `failedStep` (docs/07 §7.3):
// only where it may actually re-run the step those belong to. `failedStep` is *the* failed step
// (§3.3.10) — a reprocess of the analysis alone must not erase the extraction failure that is still
// the reason the analysis has nothing to read, and an error nobody re-ran the step for is not an
// error from a previous attempt, it is the current state of the document.
// A pointer at a step this pipeline does not have is cleared by any run, because no run could ever
// re-run it and it would otherwise outlive every attempt to get rid of it.
export function clearsRecordedFailure(
  failedStep: string | null,
  requested: ReadonlySet<DocumentStep>,
): boolean {
  if (failedStep === null) return true;
  const owner = DOCUMENT_STEPS.find((step) => step === failedStep);
  return owner === undefined || requested.has(owner);
}

// Every step starts PENDING; the pipeline moves them to DONE/FAILED/SKIPPED (docs/05 §5.5).
export function pendingSteps(): DocumentSteps {
  return {
    canonical: 'PENDING',
    preview: 'PENDING',
    markdown: 'PENDING',
    analysis: 'PENDING',
    vectorization: 'PENDING',
  };
}

// Who may change a document's title, type or composition (docs/03 §3.4). Read access is decided by
// the repository query; this is the extra rule on top of it, and it asks the document's derived
// origin rather than a column, because a document is a library document by holding a library file.
export function canEditDocumentMeta(
  user: { id: string; role: UserRole },
  document: Pick<Document, 'createdById'>,
  origin: FileOrigin,
): boolean {
  if (user.role === 'ADMIN') return true;
  // Library content is shared property: anyone who can read one can correct its title or type — the
  // alternative is a library nobody may tidy up.
  if (origin === 'LIBRARY') return true;
  // A document with no library file at all is its creator's; a share grants reading, not editing
  // (docs/08 §8.5).
  return document.createdById === user.id;
}
