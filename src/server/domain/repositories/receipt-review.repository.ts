import type {
  ReceiptDuplicatePair,
  ReceiptReviewAction,
} from '../../../shared/contracts/receipt-duplicates';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Receipt } from '../entities/receipt';
import type { Viewer } from './document.repository';

export type ReceiptReview = {
  id: string;
  ownerId: string;
  actor: { id: string; displayName: string };
  firstId: string;
  secondId: string;
  revision: string;
  action: ReceiptReviewAction;
  reverse: boolean;
  pair: ReceiptDuplicatePair;
  resultId: string | null;
  createdAt: Date;
  undoneAt: Date | null;
};
export type NewReceiptReview = Omit<ReceiptReview, 'actor' | 'undoneAt'> & { actorId: string };

export abstract class ReceiptReviewRepository {
  abstract candidates(
    viewer: Viewer,
    cursor?: string,
  ): Promise<{
    pairs: Array<{ first: Receipt; second: Receipt; reviewedRevision: string | null }>;
    nextCursor: string | null;
  }>;
  abstract latest(
    firstId: string,
    secondId: string,
    tx: TransactionHandle,
  ): Promise<ReceiptReview | null>;
  abstract find(id: string, viewer: Viewer, tx?: TransactionHandle): Promise<ReceiptReview | null>;
  abstract list(
    viewer: Viewer,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<{
    items: ReceiptReview[];
    nextCursor: string | null;
  }>;
  abstract create(input: NewReceiptReview, tx: TransactionHandle): Promise<ReceiptReview>;
  abstract undo(id: string, at: Date, tx: TransactionHandle): Promise<ReceiptReview>;
  abstract hasDependents(
    receiptIds: string[],
    exceptId: string,
    tx: TransactionHandle,
  ): Promise<boolean>;
  abstract reusableResult(
    resultId: string,
    firstId: string,
    secondId: string,
    tx: TransactionHandle,
  ): Promise<boolean>;
}
