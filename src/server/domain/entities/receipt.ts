import type { ReceiptExtraction } from '../../../shared/contracts/receipts';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { File } from './file';

// Every page is shown to the extractor; an oversized receipt fails instead of silently dropping
// its final pages. The byte bound leaves room for base64 and JSON copies in the provider request.
export const MAX_RECEIPT_PAGES = 100;
export const MAX_RECEIPT_EXTRACTION_BYTES = 32 * 1024 * 1024;

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
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lastEventAt: Date;
  deletedAt: Date | null;
  owner: { id: string; displayName: string };
};

export function isReceiptProcessing(receipt: Receipt): boolean {
  return [receipt.previewStatus, receipt.extractionStatus].some(
    (status) => status === 'PENDING' || status === 'QUEUED' || status === 'RUNNING',
  );
}
