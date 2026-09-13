import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { ConflictError } from '../../domain/errors/domain-error';
import type { JobQueue } from '../ports/job-queue';
import type { ReceiptExtractor } from '../ports/receipt-extractor';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { QueueSettings } from '../queue/queue-settings';
import {
  RECEIPT_RETRY_BATCH_SIZE,
  retryFailedReceiptsRequestSchema,
  type ReceiptProcessingOverview,
} from '../../../shared/contracts/receipt-processing';

export class RetryFailedReceipts {
  constructor(
    private readonly receipts: ReceiptRepository,
    private readonly queue: JobQueue,
    private readonly events: DocumentEventRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly settings: QueueSettings,
    private readonly extractor: ReceiptExtractor,
  ) {}

  async overview(): Promise<ReceiptProcessingOverview> {
    return {
      counts: await this.receipts.countProcessing(),
      extractorConfigured: this.extractor.isConfigured,
      batchLimit: RECEIPT_RETRY_BATCH_SIZE,
    };
  }

  async execute(limit: number, actorId: string): Promise<{ enqueued: number }> {
    limit = retryFailedReceiptsRequestSchema.parse({ limit }).limit;
    if (!this.extractor.isConfigured) {
      throw new ConflictError(
        'RECEIPT_EXTRACTOR_NOT_CONFIGURED',
        'Configure receipt extraction before retrying',
      );
    }
    if ((await this.settings.read()).paused.includes('receipt-process')) {
      throw new ConflictError('STEPS_PAUSED', 'Receipt processing is paused');
    }
    return this.unitOfWork.run(
      async (tx) => {
        const failed = await this.receipts.lockFailedForRetry(limit, tx);
        let enqueued = 0;
        for (const receipt of failed) {
          const job = await this.queue.enqueueAfterTx(
            tx,
            'receipt-process',
            { receiptId: receipt.id },
            { singletonKey: receipt.id },
          );
          if (job === null) continue;
          const steps =
            receipt.previewStatus === 'FAILED' ? ['preview', 'extraction'] : ['extraction'];
          await this.receipts.updateProcessing(
            receipt.id,
            {
              ...(receipt.previewStatus === 'FAILED' ? { previewStatus: 'QUEUED' } : {}),
              extractionStatus: 'QUEUED',
              processingError: null,
              failedStep: null,
            },
            tx,
          );
          await this.events.record(
            {
              documentId: receipt.id,
              type: 'QUEUED',
              actorId,
              payload: { steps, reason: 'retry-failed-receipt' },
            },
            tx,
          );
          enqueued++;
        }
        return { enqueued };
      },
      { timeoutMs: 30_000 },
    );
  }
}
