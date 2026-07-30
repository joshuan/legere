import type { CategorySource, DocumentSource, StepStatus } from '../../../shared/contracts/enums';

// Document entity (docs/03 §3.3.10): the deduplicated logical unit of content. Pipeline step statuses
// live on the row so progress is visible in the admin panel (docs/05 §5.5).
export type DocumentSteps = {
  canonical: StepStatus;
  preview: StepStatus;
  markdown: StepStatus;
  categorization: StepStatus;
  vectorization: StepStatus;
};

export type Document = {
  id: string;
  contentHash: string;
  source: DocumentSource;
  mimeType: string;
  ext: string;
  sizeBytes: bigint;
  pageCount: number | null;
  title: string;
  steps: DocumentSteps;
  processingError: string | null;
  failedStep: string | null;
  ocrUsed: boolean;
  categoryId: string | null;
  categorySource: CategorySource;
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
  return Object.values(steps).some((status) => status === 'PENDING');
}

// Every step starts PENDING; the pipeline moves them to DONE/FAILED/SKIPPED (docs/05 §5.5).
export function pendingSteps(): DocumentSteps {
  return {
    canonical: 'PENDING',
    preview: 'PENDING',
    markdown: 'PENDING',
    categorization: 'PENDING',
    vectorization: 'PENDING',
  };
}
