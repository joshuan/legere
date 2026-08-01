import { z } from 'zod';
import { scanSetCropModeSchema, scanSetStatusSchema } from './enums';

// Scan set contracts (docs/07 §7.3, docs/03 §3.3.16–3.3.17).

// A physical document scanned into dozens of images — a passport is about forty (docs/05 §5.6).
const MAX_ITEMS = 200;

export const scanSetItemSchema = z.object({
  documentId: z.string().uuid(),
  position: z.number().int().nonnegative(),
  title: z.string(),
  hasPreview: z.boolean(),
});
export type ScanSetItemDto = z.infer<typeof scanSetItemSchema>;

export const scanSetDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: scanSetStatusSchema,
  cropMode: scanSetCropModeSchema,
  itemCount: z.number().int().nonnegative(),
  resultDocumentId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type ScanSetDto = z.infer<typeof scanSetDtoSchema>;

export const scanSetDetailSchema = scanSetDtoSchema.extend({
  // In page order; the order is the whole point of a scan set.
  items: z.array(scanSetItemSchema),
});
export type ScanSetDetailDto = z.infer<typeof scanSetDetailSchema>;

export const listScanSetsResponseSchema = z.object({ items: z.array(scanSetDtoSchema) });
export type ListScanSetsResponse = z.infer<typeof listScanSetsResponseSchema>;

export const createScanSetRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  cropMode: scanSetCropModeSchema.default('TRIM'),
  // The order of this array is the page order (docs/07 §7.3).
  items: z.array(z.string().uuid()).min(1).max(MAX_ITEMS),
});
export type CreateScanSetRequest = z.infer<typeof createScanSetRequestSchema>;

export const updateScanSetRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    cropMode: scanSetCropModeSchema.optional(),
    items: z.array(z.string().uuid()).min(1).max(MAX_ITEMS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateScanSetRequest = z.infer<typeof updateScanSetRequestSchema>;
