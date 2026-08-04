import { z } from 'zod';

// DocumentType contracts (docs/07 §7.3, docs/03 §3.3.12).

// kebab-case: the slug is what the classifier answers with, so it has to be stable and typeable
// (docs/03 §3.3.12).
export const typeSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case words separated by single hyphens');

export const documentTypeDtoSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // How many active documents currently carry it — the number a delete confirm has to name.
  documentCount: z.number().int().nonnegative(),
});
export type DocumentTypeDto = z.infer<typeof documentTypeDtoSchema>;

export const listDocumentTypesResponseSchema = z.object({ items: z.array(documentTypeDtoSchema) });
export type ListDocumentTypesResponse = z.infer<typeof listDocumentTypesResponseSchema>;

export const createCategoryRequestSchema = z.object({
  slug: typeSlugSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
});
export type CreateDocumentTypeRequest = z.infer<typeof createCategoryRequestSchema>;

// The slug is absent on purpose: it is immutable (docs/07 §7.3). Documents, the classifier prompt
// and any bookmarked filter all refer to it.
export const updateCategoryRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateDocumentTypeRequest = z.infer<typeof updateCategoryRequestSchema>;
