import type { AgentIdentity } from '../../../shared/contracts/identity';
import type { ReceiptExtraction, ReceiptReviewState } from '../../../shared/contracts/receipts';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { File } from './file';

// Every page is shown to the extractor; an oversized receipt fails instead of silently dropping
// its final pages. The byte bound leaves room for base64 and JSON copies in the provider request.
export const MAX_RECEIPT_PAGES = 100;
export const MAX_RECEIPT_EXTRACTION_BYTES = 32 * 1024 * 1024;
// A lost delivery is recoverable once it has had the same grace period as document work.
export const RECEIPT_RECOVERY_GRACE_MS = 2 * 60 * 60 * 1000;

export type Receipt = {
  id: string;
  fileId: string;
  file: File;
  pageCount: number | null;
  previewStatus: StepStatus;
  extractionStatus: StepStatus;
  extracted: ReceiptExtraction | null;
  sourceText: string | null;
  processingError: string | null;
  failedStep: string | null;
  createdVia?: AgentIdentity | null;
  integrationId?: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lastEventAt: Date;
  deletedAt: Date | null;
  reviewState: ReceiptReviewState;
  reviewId: string | null;
  owner: { id: string; displayName: string };
};

export function isReceiptProcessing(receipt: Receipt): boolean {
  return [receipt.previewStatus, receipt.extractionStatus].some(
    (status) => status === 'PENDING' || status === 'QUEUED' || status === 'RUNNING',
  );
}
