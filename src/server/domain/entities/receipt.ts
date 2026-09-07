import type { ReceiptExtraction } from '../../../shared/contracts/receipts';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { File } from './file';

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
