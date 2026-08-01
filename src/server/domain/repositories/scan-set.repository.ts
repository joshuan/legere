import type { ScanSetCropMode, ScanSetStatus } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';

// ScanSet entities (docs/03 §3.3.16–3.3.17).
export type ScanSet = {
  id: string;
  name: string;
  createdById: string;
  status: ScanSetStatus;
  cropMode: ScanSetCropMode;
  resultDocumentId: string | null;
  error: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

export type ScanSetItem = {
  documentId: string;
  position: number;
  title: string;
  mimeType: string;
  hasPreview: boolean;
};

export type ScanSetWithItems = ScanSet & {
  items: ScanSetItem[];
};

export type CreateScanSetInput = {
  name: string;
  createdById: string;
  cropMode: ScanSetCropMode;
};

export type UpdateScanSetInput = {
  name?: string;
  cropMode?: ScanSetCropMode;
  status?: ScanSetStatus;
  resultDocumentId?: string | null;
  error?: string | null;
};

export abstract class ScanSetRepository {
  abstract listForUser(userId: string, tx?: TransactionHandle): Promise<ScanSetWithItems[]>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<ScanSetWithItems | null>;

  // Which scan set claims a given result document, if any. `resultDocumentId` is unique
  // (docs/04 §4.1), so identical merged content cannot belong to two sets at once.
  abstract findByResultDocumentId(
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<ScanSet | null>;

  abstract create(input: CreateScanSetInput, tx?: TransactionHandle): Promise<ScanSet>;

  abstract update(id: string, input: UpdateScanSetInput, tx?: TransactionHandle): Promise<ScanSet>;

  // Positions are a contiguous 0-based order, so reordering rewrites the whole set rather than
  // patching individual rows (docs/03 §3.3.17).
  abstract replaceItems(
    scanSetId: string,
    documentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void>;

  abstract softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void>;
}
