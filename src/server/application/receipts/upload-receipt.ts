import { randomUUID } from 'node:crypto';
import type { UploadReceiptResponse } from '../../../shared/contracts/receipts';
import { isImageFile, isPdfFile } from '../../domain/entities/file';
import { ConflictError, UnsupportedFormatError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { Viewer } from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import type { FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { MimeDetector } from '../ports/mime-detector';
import type { UnitOfWork } from '../ports/unit-of-work';
import { describeUpload, type UploadedFile } from '../documents/compose-document';
import { artifactKeys, servableContentType } from '../storage/artifact-keys';
import { toReceiptListDto } from './manage-receipts';

export type ReceiptUpload = UploadedFile & { sourceText?: string | undefined };

export class UploadReceipt {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly storage: FileStorage,
    private readonly mime: MimeDetector,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(viewer: Viewer, input: ReceiptUpload): Promise<UploadReceiptResponse> {
    const upload = await describeUpload(this.mime, input);
    const fileShape = { mimeType: upload.mimeType };
    if (!isImageFile(fileShape) && !isPdfFile(fileShape)) {
      throw new UnsupportedFormatError('A receipt must be an image or PDF');
    }

    const known = await this.files.findActiveByContentHash(upload.contentHash);
    if (known !== null) {
      const existing = await this.receipts.findByFileId(known.id);
      if (existing !== null) {
        const readable = await this.receipts.findReadableById(existing.id, viewer);
        if (readable === null) {
          throw new ConflictError(
            'RECEIPT_DUPLICATE',
            'This receipt already exists for another owner',
          );
        }
        return { receipt: toReceiptListDto(readable), created: false };
      }
      if ((await this.files.findDocumentIdForFile(known.id)) !== null) {
        throw new ConflictError(
          'RECEIPT_DUPLICATE',
          'These bytes already belong to a document; convert that document explicitly',
        );
      }
    }

    const fileId = randomUUID();
    const storageKey = artifactKeys.fileOriginal(fileId, upload.ext);
    await this.storage.put(storageKey, input.bytes, servableContentType(upload.mimeType));

    let stored: { receipt: Awaited<ReturnType<ReceiptRepository['create']>>; created: boolean };
    try {
      stored = await this.unitOfWork.run(async (tx) => {
        const { file, created } = await this.files.findOrCreateByContentHash(
          {
            id: fileId,
            contentHash: upload.contentHash,
            origin: 'MANAGED',
            storageKey,
            mimeType: upload.mimeType,
            ext: upload.ext,
            sizeBytes: BigInt(input.bytes.byteLength),
            name: input.fileName,
          },
          tx,
        );
        const existing = await this.receipts.findByFileId(file.id, tx);
        if (existing !== null) return { receipt: existing, created: false };
        if ((await this.files.findDocumentIdForFile(file.id, tx)) !== null) {
          throw new ConflictError('RECEIPT_DUPLICATE', 'These bytes already belong to a document');
        }

        const receipt = await this.receipts.create(
          {
            fileId: file.id,
            createdById: viewer.id,
            ...(input.sourceText === undefined ? {} : { sourceText: input.sourceText }),
          },
          tx,
        );
        await this.queue.enqueueAfterTx(tx, 'receipt-process', { receiptId: receipt.id });
        await this.events.record(
          {
            documentId: receipt.id,
            type: 'CREATED',
            actorId: viewer.id,
            payload: { source: 'UPLOAD', path: file.name },
          },
          tx,
        );
        await this.events.record(
          { documentId: receipt.id, type: 'QUEUED', actorId: viewer.id },
          tx,
        );
        return { receipt, created };
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw error;
    }

    if (!stored.created) await this.storage.delete(storageKey).catch(() => undefined);
    return { receipt: toReceiptListDto(stored.receipt), created: stored.created };
  }
}
