import type {
  ReceiptExtraction,
  ReceiptFilters,
  ReceiptSort,
} from '../../../shared/contracts/receipts';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Receipt } from '../entities/receipt';
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

export abstract class ReceiptRepository {
  abstract create(
    input: { fileId: string; createdById: string; sourceText?: string | undefined },
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
  abstract softDelete(id: string, at: Date, tx?: TransactionHandle): Promise<void>;
  abstract hardDelete(id: string, tx?: TransactionHandle): Promise<void>;
}
