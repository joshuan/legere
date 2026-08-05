import { z } from 'zod';
import { cropSchema, documentDetailDtoSchema } from './documents';

// Composing a document out of files (docs/07 §7.3 "Document files", docs/05 §5.6). Every one of
// these answers with the whole document: a composition change is never local.

// PATCH /api/documents/:id/files — the complete order, every file of the document exactly once.
export const reorderDocumentFilesRequestSchema = z.object({
  order: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderDocumentFilesRequest = z.infer<typeof reorderDocumentFilesRequestSchema>;

// PATCH /api/documents/:id/files/:fileId — `null` clears the crop and puts the whole file back.
export const updateDocumentFileRequestSchema = z.object({
  crop: cropSchema.nullable(),
});
export type UpdateDocumentFileRequest = z.infer<typeof updateDocumentFileRequestSchema>;

// GET /api/documents/:id/files/:fileId/crop-suggestion — a proposal, stored only if the client saves
// it. `method` says which answer this is: the page the detector found, or the content bounding box
// it fell back to (docs/05 §5.6).
export const cropSuggestionResponseSchema = z.object({
  crop: cropSchema,
  method: z.enum(['EDGES', 'CONTENT_BOX']),
});
export type CropSuggestionResponse = z.infer<typeof cropSuggestionResponseSchema>;

// DELETE /api/documents/:id/files/:fileId — the file leaves and becomes a document of its own.
export const splitDocumentFileResponseSchema = z.object({
  document: documentDetailDtoSchema,
  splitDocumentId: z.string().uuid(),
});
export type SplitDocumentFileResponse = z.infer<typeof splitDocumentFileResponseSchema>;

// POST /api/documents/:id/combine — the files of those documents, appended in that order.
export const combineDocumentsRequestSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(1).max(50),
});
export type CombineDocumentsRequest = z.infer<typeof combineDocumentsRequestSchema>;

// GET /api/documents/grouping-suggestions (docs/05 §5.6a). Computed, never stored.
export const groupingSuggestionSchema = z.object({
  documentIds: z.array(z.string().uuid()).min(2),
  libraryId: z.string().uuid(),
  libraryName: z.string(),
  folder: z.string(),
  // Why these were put together: a run of names, or one sitting at the scanner.
  reason: z.enum(['NAME_SEQUENCE', 'SAME_SITTING']),
});
export type GroupingSuggestion = z.infer<typeof groupingSuggestionSchema>;

export const groupingSuggestionsResponseSchema = z.object({
  items: z.array(groupingSuggestionSchema),
});
export type GroupingSuggestionsResponse = z.infer<typeof groupingSuggestionsResponseSchema>;
