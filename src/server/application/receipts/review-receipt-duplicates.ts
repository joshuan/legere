import { createHash, randomUUID } from 'node:crypto';
import type {
  ReceiptDuplicatePage,
  ReceiptDuplicatePair,
  ReceiptPairQuery,
  ReceiptReviewDto,
  ResolveReceiptPair,
} from '../../../shared/contracts/receipt-duplicates';
import type { ReceiptArtifactUrl } from '../../../shared/contracts/receipts';
import {
  isReceiptProcessing,
  MAX_RECEIPT_PAGES,
  type Receipt,
} from '../../domain/entities/receipt';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { Viewer } from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import type {
  ReceiptReview,
  ReceiptReviewRepository,
} from '../../domain/repositories/receipt-review.repository';
import { matchReceipts } from '../../domain/services/receipt-matching';
import { MAX_BINARY_BYTES, toBuffer } from '../ports/binary-source';
import type { Clock } from '../ports/clock';
import { safeDownloadFileName, type FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys, originalKeyOf, servableContentType } from '../storage/artifact-keys';
import { toReceiptListDto } from './manage-receipts';

export const MAX_RECEIPT_MERGE_BYTES = 128 * 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function receiptPairOf(first: Receipt, second: Receipt): ReceiptDuplicatePair {
  const revision = createHash('sha256')
    .update(
      canonical(
        [first, second].map((receipt) => ({
          id: receipt.id,
          file: receipt.fileId,
          hash: receipt.file.contentHash,
          owner: receipt.createdById,
          updatedAt: receipt.updatedAt.toISOString(),
          extracted: receipt.extracted,
          sourceText: receipt.sourceText,
          preview: receipt.previewStatus,
          extraction: receipt.extractionStatus,
          pages: receipt.pageCount,
        })),
      ),
    )
    .digest('hex');
  const pageCount = (first.pageCount ?? 0) + (second.pageCount ?? 0);
  return {
    first: toReceiptListDto(first),
    second: toReceiptListDto(second),
    revision,
    ...matchReceipts(first.extracted, second.extracted),
    mergeBlocked:
      first.previewStatus !== 'DONE' ||
      second.previewStatus !== 'DONE' ||
      first.pageCount === null ||
      second.pageCount === null
        ? 'preview'
        : pageCount > MAX_RECEIPT_PAGES
          ? 'pages'
          : first.file.sizeBytes + second.file.sizeBytes > BigInt(MAX_RECEIPT_MERGE_BYTES)
            ? 'size'
            : null,
  };
}

function dto(review: ReceiptReview): ReceiptReviewDto {
  return {
    id: review.id,
    action: review.action,
    reverse: review.reverse,
    pair: review.pair,
    resultId: review.resultId,
    actor: review.actor,
    createdAt: review.createdAt.toISOString(),
    undoneAt: review.undoneAt?.toISOString() ?? null,
  };
}

async function readPair(
  receipts: ReceiptRepository,
  viewer: Viewer,
  query: ReceiptPairQuery,
  tx?: TransactionHandle,
): Promise<[Receipt, Receipt]> {
  const [firstId, secondId] = [query.firstId, query.secondId].sort();
  if (firstId === undefined || secondId === undefined || firstId === secondId) throw changed();
  const first = await receipts.findReadableById(firstId, viewer, tx);
  const second = await receipts.findReadableById(secondId, viewer, tx);
  if (first === null || second === null || first.createdById !== second.createdById) {
    throw new NotFoundError('RECEIPT_NOT_FOUND', 'Receipt pair not found');
  }
  if (isReceiptProcessing(first) || isReceiptProcessing(second)) throw changed();
  return [first, second];
}

export class ReadReceiptDuplicates {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly reviews: ReceiptReviewRepository,
    private readonly storage: FileStorage,
    private readonly signedUrlTtl: number,
  ) {}

  async list(viewer: Viewer, cursor?: string): Promise<ReceiptDuplicatePage> {
    const scan = await this.reviews.candidates(viewer, cursor);
    const items = scan.pairs.flatMap(({ first, second, reviewedRevision }) => {
      if (
        isReceiptProcessing(first) ||
        isReceiptProcessing(second) ||
        first.createdById !== second.createdById
      )
        return [];
      const pair = receiptPairOf(first, second);
      return pair.kind === 'manual' || pair.revision === reviewedRevision ? [] : [pair];
    });
    return { items, nextCursor: scan.nextCursor, checkedPairs: scan.pairs.length };
  }

  async compare(viewer: Viewer, query: ReceiptPairQuery): Promise<ReceiptDuplicatePair> {
    const [first, second] = await readPair(this.receipts, viewer, query);
    return receiptPairOf(first, second);
  }

  async history(viewer: Viewer, query: { limit: number; cursor?: string | undefined }) {
    const page = await this.reviews.list(viewer, query);
    return { items: page.items.map(dto), nextCursor: page.nextCursor };
  }

  async original(viewer: Viewer, id: string, side: number): Promise<ReceiptArtifactUrl> {
    const review = await this.reviews.find(id, viewer);
    if (review === null || (side !== 0 && side !== 1)) throw new NotFoundError('RECEIPT_NOT_FOUND');
    const receipt = await this.receipts.findById(side === 0 ? review.firstId : review.secondId);
    if (receipt === null || receipt.createdById !== review.ownerId)
      throw new NotFoundError('RECEIPT_NOT_FOUND');
    return {
      url: await this.storage.getSignedUrl(originalKeyOf(receipt.file), this.signedUrlTtl, {
        disposition: 'attachment',
        fileName: receipt.file.name,
        contentType: servableContentType(receipt.file.mimeType),
      }),
    };
  }
}

export class ResolveReceiptDuplicates {
  // One whole PDF assembly at a time bounds retained intermediate buffers while Stirling's ordinary
  // gate also serves document work. A busy request can retry; it never hides anything.
  private merging = false;

  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly reviews: ReceiptReviewRepository,
    private readonly files: FileRepository,
    private readonly storage: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly queue: JobQueue,
    private readonly events: DocumentEventRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly uploadLimit: number,
  ) {}

  async execute(viewer: Viewer, input: ResolveReceiptPair): Promise<ReceiptReviewDto> {
    const replay = await this.reviews.find(input.operationId, viewer);
    if (replay !== null) return this.replay(replay, input);
    const [first, second] = await readPair(this.receipts, viewer, input);
    const pair = receiptPairOf(first, second);
    if (pair.revision !== input.revision) throw changed();
    if (input.action !== 'MERGE') {
      return this.unitOfWork.run(async (tx) => {
        await this.receipts.lockByIds([first.id, second.id], tx);
        const retry = await this.reviews.find(input.operationId, viewer, tx);
        if (retry !== null) return this.replay(retry, input);
        const [a, b] = await readPair(this.receipts, viewer, input, tx);
        const current = receiptPairOf(a, b);
        if (current.revision !== input.revision) throw changed();
        const latest = await this.reviews.latest(a.id, b.id, tx);
        if (latest !== null && latest.undoneAt === null && latest.revision === input.revision) {
          return this.replay(latest, input);
        }
        const at = this.clock.now();
        const resultId =
          input.action === 'KEEP_FIRST' ? a.id : input.action === 'KEEP_SECOND' ? b.id : null;
        if (resultId !== null)
          await this.receipts.softDelete(resultId === a.id ? b.id : a.id, at, tx);
        return dto(
          await this.reviews.create(
            {
              id: input.operationId,
              ownerId: a.createdById,
              actorId: viewer.id,
              firstId: a.id,
              secondId: b.id,
              revision: input.revision,
              pair: current,
              action: input.action,
              reverse: false,
              resultId,
              createdAt: at,
            },
            tx,
          ),
        );
      });
    }

    if (pair.mergeBlocked !== null)
      throw new ConflictError(
        'RECEIPT_MERGE_LIMIT',
        'The originals are not ready or exceed the merge limits',
      );
    if (this.merging)
      throw new ConflictError(
        'RECEIPT_MERGE_BUSY',
        'Another PDF is being assembled; retry shortly',
      );
    this.merging = true;
    const fileId = randomUUID();
    const storageKey = artifactKeys.fileOriginal(fileId, 'pdf');
    try {
      const ordered = input.reverse ? [second, first] : [first, second];
      const bytes = await this.mergeOriginals(ordered);
      const contentHash = createHash('sha256').update(bytes).digest('hex');
      await this.storage.put(storageKey, bytes, 'application/pdf');
      return await this.unitOfWork.run(async (tx) => {
        await this.receipts.lockByIds([first.id, second.id], tx);
        const retry = await this.reviews.find(input.operationId, viewer, tx);
        if (retry !== null) return this.replay(retry, input);
        const [a, b] = await readPair(this.receipts, viewer, input, tx);
        const current = receiptPairOf(a, b);
        if (current.revision !== input.revision) throw changed();
        const latest = await this.reviews.latest(a.id, b.id, tx);
        if (latest !== null && latest.undoneAt === null && latest.revision === input.revision)
          throw changed();
        const { file } = await this.files.findOrCreateByContentHash(
          {
            id: fileId,
            contentHash,
            origin: 'MANAGED',
            storageKey,
            mimeType: 'application/pdf',
            ext: 'pdf',
            sizeBytes: BigInt(bytes.length),
            name: safeDownloadFileName(
              `${ordered.map((receipt) => receipt.file.name).join(' + ')}`,
              'pdf',
            ),
          },
          tx,
        );
        let result = await this.receipts.findByFileId(file.id, tx);
        if (result !== null) {
          if (
            result.deletedAt === null ||
            result.createdById !== a.createdById ||
            !(await this.reviews.reusableResult(result.id, a.id, b.id, tx))
          )
            throw changed();
          await this.receipts.lockByIds([result.id], tx);
          await this.receipts.restore(result.id, tx);
          if (!isReceiptProcessing(result)) {
            await this.receipts.updateProcessing(
              result.id,
              { extractionStatus: 'QUEUED', processingError: null, failedStep: null },
              tx,
            );
          }
          // A job may have completed as a no-op while this result was hidden. Re-enqueue even
          // when its checkpoint still says QUEUED/RUNNING; the queue collapses waiting copies.
          await this.queue.enqueueAfterTx(tx, 'receipt-process', { receiptId: result.id });
        } else {
          if ((await this.files.findDocumentIdForFile(file.id, tx)) !== null) throw changed();
          if (file.trashedAt !== null) await this.files.untrash(file.id, tx);
          await this.files.recordPageCount(file.id, (a.pageCount ?? 0) + (b.pageCount ?? 0), tx);
          const sourceText = ordered
            .map((receipt) => receipt.sourceText)
            .filter((value) => value !== null)
            .join('\n\n');
          result = await this.receipts.create(
            {
              fileId: file.id,
              createdById: a.createdById,
              ...(sourceText === '' ? {} : { sourceText }),
              createdVia: viewer.agent ?? null,
            },
            tx,
          );
          await this.queue.enqueueAfterTx(tx, 'receipt-process', { receiptId: result.id });
          await this.events.record(
            {
              documentId: result.id,
              type: 'CREATED',
              actorId: viewer.id,
              actorAgent: viewer.agent ?? null,
            },
            tx,
          );
        }
        await this.events.record(
          {
            documentId: result.id,
            type: 'QUEUED',
            actorId: viewer.id,
            actorAgent: viewer.agent ?? null,
          },
          tx,
        );
        const at = this.clock.now();
        await this.receipts.softDelete(a.id, at, tx);
        await this.receipts.softDelete(b.id, at, tx);
        return dto(
          await this.reviews.create(
            {
              id: input.operationId,
              ownerId: a.createdById,
              actorId: viewer.id,
              firstId: a.id,
              secondId: b.id,
              revision: input.revision,
              pair: current,
              action: 'MERGE',
              reverse: input.reverse,
              resultId: result.id,
              createdAt: at,
            },
            tx,
          ),
        );
      });
    } finally {
      this.merging = false;
      // A commit whose acknowledgement was lost must not lose its original. If the reference check
      // also fails, maintenance can remove an orphan later; retaining bytes is the safe outcome.
      try {
        const committed = await this.files.findById(fileId);
        if (committed === null || committed.storageKey !== storageKey)
          await this.storage.delete(storageKey);
      } catch {
        /* Leave unconfirmed objects for maintenance. */
      }
    }
  }

  async undo(viewer: Viewer, id: string): Promise<ReceiptReviewDto> {
    const before = await this.reviews.find(id, viewer);
    if (before === null) throw new NotFoundError('RECEIPT_NOT_FOUND');
    return this.unitOfWork.run(async (tx) => {
      await this.receipts.lockByIds(
        [before.firstId, before.secondId, ...(before.resultId === null ? [] : [before.resultId])],
        tx,
      );
      const review = await this.reviews.find(id, viewer, tx);
      if (review === null) throw new NotFoundError('RECEIPT_NOT_FOUND');
      if (review.undoneAt !== null) return dto(review);
      if (
        review.action !== 'DISMISS' &&
        review.resultId !== null &&
        (await this.reviews.hasDependents([review.resultId], review.id, tx))
      ) {
        throw new ConflictError(
          'RECEIPT_REVIEW_DEPENDENCY',
          'Undo the later decision using this result first',
        );
      }
      const restoreIds =
        review.action === 'KEEP_FIRST'
          ? [review.secondId]
          : review.action === 'KEEP_SECOND'
            ? [review.firstId]
            : review.action === 'MERGE'
              ? [review.firstId, review.secondId]
              : [];
      for (const sourceId of restoreIds) {
        const receipt = await this.receipts.findById(sourceId, tx);
        if (receipt === null || receipt.createdById !== review.ownerId) throw changed();
        await this.receipts.restore(sourceId, tx);
      }
      const at = this.clock.now();
      if (review.action === 'MERGE' && review.resultId !== null) {
        await this.receipts.softDelete(review.resultId, at, tx);
      }
      return dto(await this.reviews.undo(review.id, at, tx));
    });
  }

  private replay(review: ReceiptReview, input: ResolveReceiptPair): ReceiptReviewDto {
    if (
      review.firstId !== input.firstId ||
      review.secondId !== input.secondId ||
      review.revision !== input.revision ||
      review.action !== input.action ||
      review.reverse !== input.reverse
    )
      throw changed();
    return dto(review);
  }

  private async mergeOriginals(receipts: Receipt[]): Promise<Buffer> {
    let retained = 0;
    const parts: Buffer[] = [];
    for (const receipt of receipts) {
      const source = await toBuffer(
        await this.storage.getStream(originalKeyOf(receipt.file)),
        MAX_RECEIPT_MERGE_BYTES - retained,
      );
      retained += source.length;
      const pdf =
        receipt.file.mimeType === 'application/pdf'
          ? source
          : await this.pdfs.imagesToPdf([{ body: source, fileName: receipt.file.name }]);
      if (pdf !== source) retained += pdf.length;
      if (retained > MAX_RECEIPT_MERGE_BYTES)
        throw new ConflictError(
          'RECEIPT_MERGE_LIMIT',
          'The combined originals exceed the byte limit',
        );
      parts.push(pdf);
    }
    const combined = await this.pdfs.mergePdfs(parts);
    if (combined.length > Math.min(this.uploadLimit, MAX_BINARY_BYTES))
      throw new ConflictError('RECEIPT_MERGE_LIMIT', 'The combined PDF exceeds the upload limit');
    const pages = await this.pdfs.pdfPageCount(combined);
    const expected = receipts.reduce((sum, receipt) => sum + (receipt.pageCount ?? 0), 0);
    if (pages !== expected || pages < 1 || pages > MAX_RECEIPT_PAGES) {
      throw new ConflictError(
        'RECEIPT_MERGE_LIMIT',
        'The combined PDF must contain every source page within the receipt limit',
      );
    }
    return combined;
  }
}

function changed(): ConflictError {
  return new ConflictError(
    'RECEIPT_CHANGED',
    'The receipts or this decision changed; refresh before confirming',
  );
}
