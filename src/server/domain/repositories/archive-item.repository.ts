import type { TransactionHandle } from '../../application/ports/unit-of-work';

export abstract class ArchiveItemRepository {
  abstract documentToReceipt(
    input: { id: string; fileId: string; ownerId: string },
    tx?: TransactionHandle,
  ): Promise<void>;
  abstract receiptToDocument(
    input: { id: string; title: string; ownerId: string; createdAt: Date; lastEventAt: Date },
    tx?: TransactionHandle,
  ): Promise<void>;
}
