import type { AutoValues } from '../../../shared/contracts/documents';
import type {
  ValueSource,
  DocumentSource,
  StepSkipReason,
  StepStatus,
  UserRole,
} from '../../../shared/contracts/enums';

// Document entity (docs/03 §3.3.10): the deduplicated logical unit of content. Pipeline step statuses
// live on the row so progress is visible in the admin panel (docs/05 §5.5).
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
  contentHash: string;
  source: DocumentSource;
  mimeType: string;
  ext: string;
  sizeBytes: bigint;
  pageCount: number | null;
  title: string;
  // Who called it that: nobody (the file name), the analysis, or a person (docs/03 §3.3.10).
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
  scanSetId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

// Derived, never stored (docs/03 §3.3.10). A LIBRARY document is available while at least one of its
// refs is live in a library that is itself active; a DERIVED document is always available, since its
// source PDF lives in S3 rather than on the volume.
export function isAvailable(
  document: Pick<Document, 'source'>,
  liveRefsInActiveLibraries: number,
): boolean {
  if (document.source === 'DERIVED') return true;
  return liveRefsInActiveLibraries > 0;
}

// True while any step still has work to do and nothing it depends on has failed (docs/03 §3.3.10).
export function isProcessing(steps: DocumentSteps): boolean {
  return Object.values(steps).some((status) => status === 'PENDING' || status === 'RUNNING');
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

// Who may change a document's title or documentType (docs/03 §3.4). Read access is decided by the
// repository query; this is the extra rule on top of it.
export function canEditDocumentMeta(
  user: { id: string; role: UserRole },
  document: Pick<Document, 'source' | 'createdById'>,
): boolean {
  if (user.role === 'ADMIN') return true;
  // Library documents are shared property: anyone who can read one can correct its title or
  // documentType — the alternative is a library nobody may tidy up.
  if (document.source === 'LIBRARY') return true;
  // A derived document is its creator's; a share grants reading, not editing (docs/08 §8.5).
  return document.createdById === user.id;
}
