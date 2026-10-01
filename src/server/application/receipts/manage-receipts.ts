import type {
  ListReceiptsResponse,
  ListReceiptsQuery,
  ReceiptArtifactUrl,
  ReceiptDetailDto,
  ReceiptListItemDto,
  ReceiptReference,
} from '../../../shared/contracts/receipts';
import { isReceiptProcessing, type Receipt } from '../../domain/entities/receipt';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { Viewer } from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import type { ReceiptReviewRepository } from '../../domain/repositories/receipt-review.repository';
import type { Clock } from '../ports/clock';
import type { FileStorage } from '../ports/file-storage';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys, originalKeyOf, servableContentType } from '../storage/artifact-keys';

export function toReceiptListDto(receipt: Receipt): ReceiptListItemDto {
  return {
    id: receipt.id,
    fileName: receipt.file.name,
    mimeType: receipt.file.mimeType,
    ext: receipt.file.ext,
    sizeBytes: receipt.file.sizeBytes.toString(),
    pageCount: receipt.pageCount,
    previewStatus: receipt.previewStatus,
    extractionStatus: receipt.extractionStatus,
    processing: receipt.reviewState === 'ACTIVE' && isReceiptProcessing(receipt),
    extracted: receipt.extracted,
    processingError: receipt.processingError,
    createdAt: receipt.createdAt.toISOString(),
    updatedAt: receipt.updatedAt.toISOString(),
    owner: receipt.owner,
    createdVia: receipt.createdVia ?? null,
  };
}

export class ListReceipts {
  constructor(private readonly receipts: ReceiptRepository) {}

  async execute(viewer: Viewer, query: ListReceiptsQuery): Promise<ListReceiptsResponse> {
    const page = await this.receipts.list(viewer, query);
    return { items: page.items.map(toReceiptListDto), nextCursor: page.nextCursor };
  }
}

export class GetReceipt {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly reviews: ReceiptReviewRepository,
  ) {}

  async execute(viewer: Viewer, id: string): Promise<ReceiptDetailDto> {
    const receipt = await this.read(viewer, id);
    return {
      ...toReceiptListDto(receipt),
      lastEventAt: receipt.lastEventAt.toISOString(),
      sourceText: receipt.sourceText,
      reference: await this.reference(viewer, receipt),
    };
  }

  private async reference(viewer: Viewer, receipt: Receipt): Promise<ReceiptReference> {
    const reference: ReceiptReference = {
      state: receipt.reviewState,
      replacementId: null,
      restoredReceiptIds: [],
      reviewId: receipt.reviewId,
    };
    if (receipt.reviewId === null) return reference;
    const review = await this.reviews.find(receipt.reviewId, viewer);
    if (review === null || review.ownerId !== receipt.createdById)
      return { ...reference, reviewId: null };
    const ids =
      receipt.reviewState === 'REPLACED'
        ? review.resultId === null
          ? []
          : [review.resultId]
        : review.reverse
          ? [review.secondId, review.firstId]
          : [review.firstId, review.secondId];
    const readable: string[] = [];
    for (const id of ids) {
      const target = await this.receipts.findReadableById(id, viewer);
      if (target !== null && target.createdById === receipt.createdById) readable.push(id);
    }
    return {
      ...reference,
      replacementId: receipt.reviewState === 'REPLACED' ? (readable[0] ?? null) : null,
      restoredReceiptIds: receipt.reviewState === 'MERGE_UNDONE' ? readable : [],
    };
  }

  private async read(viewer: Viewer, id: string): Promise<Receipt> {
    const receipt = await this.receipts.findReadableById(id, viewer);
    if (receipt === null) throw new NotFoundError('RECEIPT_NOT_FOUND', 'Receipt not found');
    return receipt;
  }
}

export class GetReceiptArtifactUrl {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly storage: FileStorage,
    private readonly signedUrlTtlSec: number,
  ) {}

  async original(viewer: Viewer, id: string, download: boolean): Promise<ReceiptArtifactUrl> {
    const receipt = await this.read(viewer, id);
    const delivery = download
      ? {
          disposition: 'attachment' as const,
          contentType: servableContentType(receipt.file.mimeType),
          fileName: receipt.file.name,
        }
      : {
          disposition: 'inline' as const,
          contentType: servableContentType(receipt.file.mimeType),
        };
    return {
      url: await this.storage.getSignedUrl(
        originalKeyOf(receipt.file),
        this.signedUrlTtlSec,
        delivery,
      ),
    };
  }

  async thumbnail(viewer: Viewer, id: string): Promise<ReceiptArtifactUrl> {
    await this.read(viewer, id);
    return this.imageUrl(artifactKeys.receiptThumbnail(id));
  }

  async page(viewer: Viewer, id: string, page: number): Promise<ReceiptArtifactUrl> {
    const receipt = await this.read(viewer, id);
    if (receipt.pageCount === null || page < 0 || page >= receipt.pageCount) {
      throw new NotFoundError('NOT_FOUND', 'Receipt page not found');
    }
    return this.imageUrl(artifactKeys.receiptPage(id, page));
  }

  private async imageUrl(key: string): Promise<ReceiptArtifactUrl> {
    return {
      url: await this.storage.getSignedUrl(key, this.signedUrlTtlSec, {
        disposition: 'inline',
        contentType: 'image/jpeg',
      }),
    };
  }

  private async read(viewer: Viewer, id: string): Promise<Receipt> {
    const receipt = await this.receipts.findReadableById(id, viewer);
    if (receipt === null) throw new NotFoundError('RECEIPT_NOT_FOUND', 'Receipt not found');
    return receipt;
  }
}

export class DeleteReceipt {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly files: FileRepository,
    private readonly storage: FileStorage,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(viewer: Viewer, id: string): Promise<{ ok: true }> {
    const receipt = await this.receipts.findReadableById(id, viewer);
    if (receipt === null) throw new NotFoundError('RECEIPT_NOT_FOUND', 'Receipt not found');
    const at = this.clock.now();
    await this.unitOfWork.run(async (tx) => {
      await this.receipts.lockByIds([id], tx);
      const current = await this.receipts.findReadableById(id, viewer, tx);
      if (current === null) throw new NotFoundError('RECEIPT_NOT_FOUND', 'Receipt not found');
      if (current.reviewState !== 'ACTIVE')
        throw new ConflictError(
          'RECEIPT_CHANGED',
          'Undo the review decision before deleting its preserved receipt',
        );
      await this.files.trash(
        {
          fileIds: [current.fileId],
          reason: 'RECEIPT_DELETED',
          trashedFrom: current.file.name,
          archiveKind: 'RECEIPT',
          ownerId: current.createdById,
          at,
        },
        tx,
      );
      await this.receipts.hardDelete(id, tx);
    });

    // Derived receipt images are disposable; a failed object delete leaves only an orphan that the
    // ordinary maintenance sweep can remove.
    try {
      const objects = await this.storage.list(artifactKeys.receiptPrefix(id));
      for (const object of objects) await this.storage.delete(object.key);
    } catch {
      // The database deletion is already committed and is the authoritative outcome.
    }
    return { ok: true };
  }
}
