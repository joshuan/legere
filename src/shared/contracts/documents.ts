import { z } from 'zod';

// Document contracts (docs/07 §7.3). The read model lands with M5; what is here is what the
// pipeline needs: re-running a document, in whole or in part.

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
