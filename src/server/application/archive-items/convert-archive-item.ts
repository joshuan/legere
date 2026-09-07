import type { ConvertArchiveItemResponse } from '../../../shared/contracts/receipts';
import { canDestroyDocumentContent, isProcessing } from '../../domain/entities/document';
import { isReceiptProcessing } from '../../domain/entities/receipt';
import { isImageFile, isPdfFile } from '../../domain/entities/file';
import { ConflictError, ForbiddenError, NotFoundError } from '../../domain/errors/domain-error';
import type { ArchiveItemRepository } from '../../domain/repositories/archive-item.repository';
import type { CollectionRepository } from '../../domain/repositories/collection.repository';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import { pagesForFile } from '../../domain/entities/document-page';
import { titleOf } from '../documents/compose-document';
import type { FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys } from '../storage/artifact-keys';

export class ConvertArchiveItem {
  constructor(
    private readonly archiveItems: ArchiveItemRepository,
    private readonly documents: DocumentRepository,
    private readonly receipts: ReceiptRepository,
    private readonly files: FileRepository,
    private readonly collections: CollectionRepository,
    private readonly events: DocumentEventRepository,
    private readonly storage: FileStorage,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    id: string,
    target: 'DOCUMENT' | 'RECEIPT',
  ): Promise<ConvertArchiveItemResponse> {
    if (target === 'RECEIPT') return this.toReceipt(viewer, id);
    return this.toDocument(viewer, id);
  }

  private async toReceipt(viewer: Viewer, id: string): Promise<ConvertArchiveItemResponse> {
    const detail = await this.documents.findReadableById(id, viewer);
    if (detail === null) {
      if ((await this.receipts.findReadableById(id, viewer)) !== null)
        return { id, kind: 'RECEIPT' };
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }
    if (!canDestroyDocumentContent(viewer, detail.document, detail.files[0]?.origin ?? 'MANAGED')) {
      throw new ForbiddenError();
    }
    if (isProcessing(detail.document.steps)) {
      throw new ConflictError(
        'ARCHIVE_KIND_CONFLICT',
        'Wait for document processing to settle before changing its kind',
      );
    }
    if (detail.files.length !== 1 || detail.files[0]?.origin !== 'MANAGED') {
      throw new ConflictError(
        'ARCHIVE_KIND_CONFLICT',
        'Only a one-file managed document can become a receipt; library originals stay documents',
      );
    }
    const file = detail.files[0];
    if (!isImageFile(file) && !isPdfFile(file)) {
      throw new ConflictError(
        'ARCHIVE_KIND_CONFLICT',
        'Only an image or PDF document can become a receipt',
      );
    }
    const homes = await this.files.listDocumentIdsForFile(file.id);
    if (homes.some((documentId) => documentId !== id)) {
      throw new ConflictError(
        'ARCHIVE_KIND_CONFLICT',
        'A file read by another document cannot become a receipt',
      );
    }
    const ownerId = detail.document.createdById ?? viewer.id;
    await this.unitOfWork.run(async (tx) => {
      await this.collections.removeItemEverywhere(id, tx);
      await this.archiveItems.documentToReceipt({ id, fileId: file.id, ownerId }, tx);
      await this.queue.enqueueAfterTx(tx, 'receipt-process', { receiptId: id });
      await this.events.record(
        {
          documentId: id,
          type: 'KIND_CHANGED',
          actorId: viewer.id,
          payload: { fromKind: 'DOCUMENT', toKind: 'RECEIPT' },
        },
        tx,
      );
      await this.events.record({ documentId: id, type: 'QUEUED', actorId: viewer.id }, tx);
    });
    await this.deleteKeys([
      artifactKeys.canonicalPdf(id),
      artifactKeys.preview(id),
      artifactKeys.thumbnail(id),
    ]);
    return { id, kind: 'RECEIPT' };
  }

  private async toDocument(viewer: Viewer, id: string): Promise<ConvertArchiveItemResponse> {
    const receipt = await this.receipts.findReadableById(id, viewer);
    if (receipt === null) {
      if ((await this.documents.findReadableById(id, viewer)) !== null)
        return { id, kind: 'DOCUMENT' };
      throw new NotFoundError('RECEIPT_NOT_FOUND', 'Receipt not found');
    }
    if (isReceiptProcessing(receipt)) {
      throw new ConflictError(
        'ARCHIVE_KIND_CONFLICT',
        'Wait for receipt processing to settle before changing its kind',
      );
    }
    await this.unitOfWork.run(async (tx) => {
      await this.archiveItems.receiptToDocument(
        {
          id,
          title: titleOf(receipt.file.name),
          ownerId: receipt.createdById,
          createdAt: receipt.createdAt,
          lastEventAt: receipt.lastEventAt,
        },
        tx,
      );
      await this.files.appendPages(id, pagesForFile(receipt.file), tx);
      await this.queue.enqueueAfterTx(tx, 'document-process', { documentId: id });
      await this.events.record(
        {
          documentId: id,
          type: 'KIND_CHANGED',
          actorId: viewer.id,
          payload: { fromKind: 'RECEIPT', toKind: 'DOCUMENT' },
        },
        tx,
      );
      await this.events.record({ documentId: id, type: 'QUEUED', actorId: viewer.id }, tx);
    });
    try {
      const objects = await this.storage.list(artifactKeys.receiptPrefix(id));
      await this.deleteKeys(objects.map(({ key }) => key));
    } catch {
      // Orphan maintenance owns artifacts left after the committed profile swap.
    }
    return { id, kind: 'DOCUMENT' };
  }

  private async deleteKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) await this.storage.delete(key).catch(() => undefined);
  }
}
