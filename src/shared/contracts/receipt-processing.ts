import { z } from 'zod';

export const RECEIPT_RETRY_BATCH_SIZE = 200;
export const receiptProcessingCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  retryable: z.number().int().nonnegative(),
});
export type ReceiptProcessingCounts = z.infer<typeof receiptProcessingCountsSchema>;
export const receiptProcessingOverviewSchema = z.object({
  counts: receiptProcessingCountsSchema,
  extractorConfigured: z.boolean(),
  batchLimit: z.literal(RECEIPT_RETRY_BATCH_SIZE),
});
export type ReceiptProcessingOverview = z.infer<typeof receiptProcessingOverviewSchema>;
export const retryFailedReceiptsRequestSchema = z
  .object({
    limit: z.number().int().min(1).max(RECEIPT_RETRY_BATCH_SIZE).default(RECEIPT_RETRY_BATCH_SIZE),
  })
  .strict();
export const retryFailedReceiptsResponseSchema = z.object({
  enqueued: z.number().int().nonnegative(),
});
