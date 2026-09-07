import { z } from 'zod';
import { paginatedSchema } from './common';
import { stepStatusSchema } from './enums';

export const receiptExtractionSchema = z.object({
  schema: z.object({ slug: z.literal('receipt'), version: z.number().int().positive() }),
  values: z.record(z.unknown()),
  confidence: z.number().min(0).max(100).nullable(),
});
export type ReceiptExtraction = z.infer<typeof receiptExtractionSchema>;

export const receiptListItemSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  ext: z.string(),
  sizeBytes: z.string(),
  pageCount: z.number().int().positive().nullable(),
  previewStatus: stepStatusSchema,
  extractionStatus: stepStatusSchema,
  processing: z.boolean(),
  extracted: receiptExtractionSchema.nullable(),
  processingError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  owner: z.object({ id: z.string().uuid(), displayName: z.string() }),
});
export type ReceiptListItemDto = z.infer<typeof receiptListItemSchema>;

export const listReceiptsResponseSchema = paginatedSchema(receiptListItemSchema);
export type ListReceiptsResponse = z.infer<typeof listReceiptsResponseSchema>;

export const receiptDetailSchema = receiptListItemSchema.extend({
  lastEventAt: z.string().datetime(),
  sourceText: z.string().nullable(),
});
export type ReceiptDetailDto = z.infer<typeof receiptDetailSchema>;

export const uploadReceiptResponseSchema = z.object({
  receipt: receiptListItemSchema,
  created: z.boolean(),
});
export type UploadReceiptResponse = z.infer<typeof uploadReceiptResponseSchema>;

export const receiptArtifactUrlSchema = z.object({ url: z.string().url() });
export type ReceiptArtifactUrl = z.infer<typeof receiptArtifactUrlSchema>;

export const convertArchiveItemResponseSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(['DOCUMENT', 'RECEIPT']),
});
export type ConvertArchiveItemResponse = z.infer<typeof convertArchiveItemResponseSchema>;

export const RECEIPT_SOURCE_TEXT_MAX_CHARS = 500_000;
export const uploadReceiptFieldsSchema = z.object({
  text: z.string().max(RECEIPT_SOURCE_TEXT_MAX_CHARS).optional(),
});
export type UploadReceiptFields = z.infer<typeof uploadReceiptFieldsSchema>;
