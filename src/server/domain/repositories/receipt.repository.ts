import type { AgentIdentity } from '../../../shared/contracts/identity';
import type {
  ReceiptExtraction,
  ReceiptFilters,
  ReceiptSort,
  ReceiptReviewState,
} from '../../../shared/contracts/receipts';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Receipt } from '../entities/receipt';
import type { ReceiptProcessingCounts } from '../../../shared/contracts/receipt-processing';
import type { Viewer } from './document.repository';

export type ReceiptProcessingUpdate = {
  previewStatus?: StepStatus;
  extractionStatus?: StepStatus;
  pageCount?: number | null;
  extracted?: ReceiptExtraction | null;
  processingError?: string | null;
  failedStep?: string | null;
};

export type ReceiptListInput = ReceiptFilters & {
  limit: number;
  cursor?: string | undefined;
  sort?: ReceiptSort | undefined;
};

export type ReceiptProcessingState = Pick<Receipt, 'id' | 'previewStatus' | 'extractionStatus'>;

export abstract class ReceiptRepository {
  abstract lockByIds(ids: string[], tx: TransactionHandle): Promise<void>;
  abstract setReviewState(
    id: string,
    state: ReceiptReviewState,
    reviewId: string | null,
    at: Date,
    tx: TransactionHandle,
  ): Promise<void>;
  abstract countProcessing(): Promise<ReceiptProcessingCounts>;
  // Terminal input/extraction failures are deliberately excluded from automatic recovery.
  abstract lockStaleUnstarted(
    olderThan: Date,
    limit: number,
    tx: TransactionHandle,
  ): Promise<ReceiptProcessingState[]>;
  // Locks failed or abandoned work through the caller's enqueue/status transaction; skips live jobs.
  abstract lockFailedForRetry(
    limit: number,
    tx: TransactionHandle,
  ): Promise<
    Array<{
      id: string;
      previewStatus: StepStatus;
      extractionStatus: StepStatus;
    }>
  >;
  abstract create(
    input: {
      fileId: string;
      createdById: string;
      sourceText?: string | undefined;
      createdVia?: AgentIdentity | null;
    },
    tx?: TransactionHandle,
  ): Promise<Receipt>;
  abstract findById(id: string, tx?: TransactionHandle): Promise<Receipt | null>;
  abstract findReadableById(
    id: string,
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<Receipt | null>;
  abstract findByFileId(fileId: string, tx?: TransactionHandle): Promise<Receipt | null>;
  abstract list(
    viewer: Viewer,
    query: ReceiptListInput,
    tx?: TransactionHandle,
  ): Promise<{ items: Receipt[]; nextCursor: string | null }>;
  abstract updateProcessing(
    id: string,
    update: ReceiptProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Receipt>;
  abstract filterExistingIds(ids: string[], tx?: TransactionHandle): Promise<string[]>;
  abstract hardDelete(id: string, tx?: TransactionHandle): Promise<void>;
}
