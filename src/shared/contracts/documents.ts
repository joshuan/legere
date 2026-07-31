import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import {
  categorySourceSchema,
  documentSourceSchema,
  fileRefStatusSchema,
  stepStatusSchema,
} from './enums';

// Document contracts (docs/07 §7.3).

// The five steps of docs/05 §5.5, named the way the API and the UI refer to them.
export const documentStepSchema = z.enum([
  'canonical',
  'preview',
  'markdown',
  'categorization',
  'vectorization',
]);
export type DocumentStep = z.infer<typeof documentStepSchema>;

export const DOCUMENT_STEPS: readonly DocumentStep[] = documentStepSchema.options;

// Derived, never stored (docs/03 §3.3.10): a LIBRARY document is available while at least one of its
// files is still on a mounted volume.
export const availabilitySchema = z.enum(['AVAILABLE', 'UNAVAILABLE']);
export type Availability = z.infer<typeof availabilitySchema>;

export const documentCategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});

export const documentListDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  ext: z.string(),
  mimeType: z.string(),
  // BigInt travels as a decimal string (docs/07 §7.4).
  sizeBytes: z.string(),
  pageCount: z.number().int().nullable(),
  category: documentCategorySchema.nullable(),
  availability: availabilitySchema,
  processing: z.boolean(),
  source: documentSourceSchema,
  hasPreview: z.boolean(),
  createdAt: z.string().datetime(),
});
export type DocumentListDto = z.infer<typeof documentListDtoSchema>;

export const documentStepsSchema = z.object({
  canonical: stepStatusSchema,
  preview: stepStatusSchema,
  markdown: stepStatusSchema,
  categorization: stepStatusSchema,
  vectorization: stepStatusSchema,
});

// Where a document's bytes live, as far as the caller may know: refs in libraries they cannot see
// are omitted entirely (docs/07 §7.3).
export const documentFileRefSchema = z.object({
  libraryId: z.string().uuid(),
  libraryName: z.string(),
  path: z.string(),
  status: fileRefStatusSchema,
});

export const documentDetailDtoSchema = documentListDtoSchema.extend({
  contentHash: z.string(),
  ocrUsed: z.boolean(),
  categorySource: categorySourceSchema,
  steps: documentStepsSchema,
  processingError: z.string().nullable(),
  failedStep: z.string().nullable(),
  fileRefs: z.array(documentFileRefSchema),
  createdBy: z.object({ id: z.string().uuid(), displayName: z.string() }).nullable(),
  scanSetId: z.string().uuid().nullable(),
});
export type DocumentDetailDto = z.infer<typeof documentDetailDtoSchema>;

// Query strings arrive as strings; booleans are spelled out rather than coerced, so `?processing=0`
// cannot silently mean true.
const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  libraryId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  availability: availabilitySchema.optional(),
  processing: queryBoolean,
  source: documentSourceSchema.optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const listDocumentsResponseSchema = paginatedSchema(documentListDtoSchema);
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

// `categoryId: null` clears the category; absent leaves it alone (docs/07 §7.4).
export const updateDocumentRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    categoryId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

// An absent or empty list means the whole pipeline (docs/07 §7.3).
export const reprocessRequestSchema = z.object({
  steps: z.array(documentStepSchema).min(1).max(DOCUMENT_STEPS.length).optional(),
});
export type ReprocessRequest = z.infer<typeof reprocessRequestSchema>;

export const reprocessResponseSchema = z.object({
  documentId: z.string().uuid(),
  steps: z.array(documentStepSchema),
});
export type ReprocessResponse = z.infer<typeof reprocessResponseSchema>;

export const documentMarkdownResponseSchema = z.object({ markdown: z.string().nullable() });
export type DocumentMarkdownResponse = z.infer<typeof documentMarkdownResponseSchema>;
