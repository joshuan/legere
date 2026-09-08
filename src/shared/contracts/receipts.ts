import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
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

// The receipt shelf is arranged by facts of the purchase rather than by document lifecycle. Every
// order is descending and uses the receipt id as its stable tiebreak (docs/15 §15.7).
export const receiptSortSchema = z.enum(['purchasedAt', 'createdAt', 'total']);
export type ReceiptSort = z.infer<typeof receiptSortSchema>;
export const RECEIPT_SORTS: readonly ReceiptSort[] = receiptSortSchema.options;
export const DEFAULT_RECEIPT_SORT: ReceiptSort = 'purchasedAt';

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > 2100) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const receiptDateQuerySchema = z.string().refine(isCalendarDate, 'Expected a calendar date');
const optionalQueryNumber = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().finite().optional(),
);

// All filters target the extracted receipt facts. Rows whose extraction has not produced a fact do
// not match a filter on that fact; without filters they remain on the shelf, after the known values
// in the nullable purchase-date and total orders.
export const receiptFiltersSchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  purchasedFrom: receiptDateQuerySchema.optional(),
  purchasedTo: receiptDateQuerySchema.optional(),
  country: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .optional(),
  amountMin: optionalQueryNumber,
  amountMax: optionalQueryNumber,
});
export type ReceiptFilters = z.infer<typeof receiptFiltersSchema>;

export const listReceiptsQuerySchema = paginationQuerySchema
  .merge(receiptFiltersSchema)
  .extend({ sort: receiptSortSchema.default(DEFAULT_RECEIPT_SORT) })
  .superRefine((value, context) => {
    if (
      value.purchasedFrom !== undefined &&
      value.purchasedTo !== undefined &&
      value.purchasedFrom > value.purchasedTo
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['purchasedTo'],
        message: 'The end of the purchase-date range must not precede its start',
      });
    }
    if (
      value.amountMin !== undefined &&
      value.amountMax !== undefined &&
      value.amountMin > value.amountMax
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountMax'],
        message: 'The maximum amount must not be less than the minimum amount',
      });
    }
  });
export type ListReceiptsQuery = z.infer<typeof listReceiptsQuerySchema>;

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
