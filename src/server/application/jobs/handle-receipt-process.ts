import { z } from 'zod';
import { fieldSchemaFor, sanitizeFieldValues } from '../../../shared/contracts/document-fields';
import type { PageImage } from '../ports/document-analyst';
import type { ReceiptExtractor } from '../ports/receipt-extractor';
import { isImageFile, isPdfFile } from '../../domain/entities/file';
import type { File } from '../../domain/entities/file';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import { toBuffer } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { PdfToolbox } from '../ports/pdf-toolbox';
import { artifactKeys, originalKeyOf } from '../storage/artifact-keys';
import { JobHandler } from './job-handler';
import { ServiceUnavailableError } from '../ports/service-unavailable';

const payloadSchema = z.object({ receiptId: z.string().uuid() });
const PREVIEW_QUALITY = 82;
const THUMB_QUALITY = 75;

export type ReceiptProcessingSettings = {
  previewMaxDim: number;
  thumbMaxDim: number;
  analystPageImageMaxDim: number;
};

// The deliberately short receipt pipeline (docs/15): render display images, then ask for the
// versioned receipt fields. It never creates a canonical PDF and never calls a text/OCR/vector port.
export class HandleReceiptProcess extends JobHandler {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly fileRows: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly storage: FileStorage,
    private readonly pdfs: PdfToolbox,
    private readonly images: ImageTool,
    private readonly analyst: ReceiptExtractor,
    private readonly settings: ReceiptProcessingSettings,
  ) {
    super();
  }

  // Expiry does not cancel a pg-boss callback. Serialize replacement deliveries in this process
  // so a long provider hold cannot produce concurrent writes to the same receipt.
  private readonly inFlight = new Map<string, Promise<void>>();

  async handle(payload: unknown): Promise<void> {
    const { receiptId } = payloadSchema.parse(payload);
    const predecessor = this.inFlight.get(receiptId) ?? Promise.resolve();
    const execution = predecessor.catch(() => undefined).then(() => this.run(receiptId));
    this.inFlight.set(receiptId, execution);
    try {
      await execution;
    } finally {
      if (this.inFlight.get(receiptId) === execution) this.inFlight.delete(receiptId);
    }
  }

  private async run(receiptId: string): Promise<void> {
    const receipt = await this.receipts.findById(receiptId);
    if (receipt === null || receipt.deletedAt !== null) return;
    if (receipt.previewStatus === 'DONE' && receipt.extractionStatus === 'DONE') return;

    // Persisted previews are a checkpoint. AI retries need only resized display images.
    const pages =
      receipt.previewStatus === 'DONE' && receipt.pageCount !== null
        ? await this.loadPages(receipt.id, receipt.pageCount)
        : await this.render(receipt.id, receipt.file);
    if (pages === null) return;
    await this.extract(receipt.id, pages, receipt.sourceText);
  }

  private async loadPages(receiptId: string, pageCount: number): Promise<PageImage[]> {
    const pages: PageImage[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      const source = await toBuffer(
        await this.storage.getStream(artifactKeys.receiptPage(receiptId, index)),
      );
      pages.push({
        bytes: await this.images.toJpegPreview(source, {
          maxDim: this.settings.analystPageImageMaxDim,
        }),
      });
    }
    return pages;
  }

  private async render(receiptId: string, file: File): Promise<PageImage[] | null> {
    await this.receipts.updateProcessing(receiptId, {
      previewStatus: 'RUNNING',
      processingError: null,
      failedStep: null,
    });
    await this.events.record({
      documentId: receiptId,
      type: 'STEP_STARTED',
      payload: { step: 'preview' },
    });

    try {
      const original = await toBuffer(await this.storage.getStream(originalKeyOf(file)));
      const analystPages: PageImage[] = [];
      let pageCount: number;

      if (isPdfFile(file)) {
        pageCount = await this.pdfs.pdfPageCount(original);
        for (let index = 0; index < pageCount; index += 1) {
          const rendered = await this.pdfs.pdfPageJpg(original, { page: index + 1 });
          await this.storePage(receiptId, index, rendered, analystPages);
        }
      } else if (isImageFile(file)) {
        pageCount = 1;
        await this.storePage(receiptId, 0, original, analystPages);
      } else {
        throw new Error('A receipt original is neither an image nor a PDF');
      }

      await this.fileRows.recordPageCount(file.id, pageCount);
      await this.receipts.updateProcessing(receiptId, {
        previewStatus: 'DONE',
        pageCount,
      });
      await this.events.record({
        documentId: receiptId,
        type: 'STEP_FINISHED',
        payload: { step: 'preview', status: 'DONE', pages: pageCount },
      });
      return analystPages;
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        await this.receipts.updateProcessing(receiptId, { previewStatus: 'QUEUED' });
        throw error;
      }
      await this.receipts.updateProcessing(receiptId, {
        previewStatus: 'FAILED',
        extractionStatus: 'FAILED',
        processingError: messageOf(error),
        failedStep: 'preview',
      });
      await this.events.record({
        documentId: receiptId,
        type: 'STEP_FINISHED',
        payload: { step: 'preview', status: 'FAILED', error: messageOf(error) },
      });
      return null;
    }
  }

  private async storePage(
    receiptId: string,
    index: number,
    source: Buffer,
    analystPages: PageImage[],
  ): Promise<void> {
    const [display, analystPage] = await Promise.all([
      this.images.toJpegPreview(source, {
        maxDim: this.settings.previewMaxDim,
        quality: PREVIEW_QUALITY,
      }),
      this.images.toJpegPreview(source, { maxDim: this.settings.analystPageImageMaxDim }),
    ]);
    await this.storage.put(artifactKeys.receiptPage(receiptId, index), display, 'image/jpeg');
    analystPages.push({ bytes: analystPage });
    if (index === 0) {
      const thumb = await this.images.toJpegPreview(source, {
        maxDim: this.settings.thumbMaxDim,
        quality: THUMB_QUALITY,
      });
      await this.storage.put(artifactKeys.receiptThumbnail(receiptId), thumb, 'image/jpeg');
    }
  }

  private async extract(
    receiptId: string,
    pages: readonly PageImage[],
    sourceText: string | null,
  ): Promise<void> {
    if (!this.analyst.isConfigured) {
      await this.receipts.updateProcessing(receiptId, { extractionStatus: 'SKIPPED' });
      await this.events.record({
        documentId: receiptId,
        type: 'STEP_FINISHED',
        payload: { step: 'extraction', status: 'SKIPPED', reason: 'NOT_CONFIGURED' },
      });
      return;
    }

    await this.receipts.updateProcessing(receiptId, { extractionStatus: 'RUNNING' });
    await this.events.record({
      documentId: receiptId,
      type: 'STEP_STARTED',
      payload: { step: 'extraction' },
    });
    try {
      const schema = fieldSchemaFor('receipt');
      if (schema === null) throw new Error('Receipt field schema is missing');
      const answer = await this.analyst.extractFields(schema, sourceText ?? '', pages);
      const values = sanitizeFieldValues(schema, answer.values);
      await this.receipts.updateProcessing(receiptId, {
        extractionStatus: 'DONE',
        extracted: {
          schema: { slug: 'receipt', version: schema.version },
          values,
          confidence: answer.confidence,
        },
        processingError: null,
        failedStep: null,
      });
      await this.events.record({
        documentId: receiptId,
        type: 'STEP_FINISHED',
        payload: {
          step: 'extraction',
          status: 'DONE',
          confidence: answer.confidence ?? undefined,
          ...(answer.usage ?? {}),
        },
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableError) {
        await this.receipts.updateProcessing(receiptId, {
          extractionStatus: 'QUEUED',
          processingError: null,
          failedStep: null,
        });
        throw error;
      }
      await this.receipts.updateProcessing(receiptId, {
        extractionStatus: 'FAILED',
        processingError: messageOf(error),
        failedStep: 'extraction',
      });
      await this.events.record({
        documentId: receiptId,
        type: 'STEP_FINISHED',
        payload: { step: 'extraction', status: 'FAILED', error: messageOf(error) },
      });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
