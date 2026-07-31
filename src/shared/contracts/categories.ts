import { z } from 'zod';

// Category contracts (docs/07 §7.3, docs/03 §3.3.12).

// kebab-case: the slug is what the classifier answers with, so it has to be stable and typeable
// (docs/03 §3.3.12).
export const categorySlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case words separated by single hyphens');

export const categoryDtoSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // How many active documents currently carry it — the number a delete confirm has to name.
  documentCount: z.number().int().nonnegative(),
});
export type CategoryDto = z.infer<typeof categoryDtoSchema>;

export const listCategoriesResponseSchema = z.object({ items: z.array(categoryDtoSchema) });
export type ListCategoriesResponse = z.infer<typeof listCategoriesResponseSchema>;

export const createCategoryRequestSchema = z.object({
  slug: categorySlugSchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
});
export type CreateCategoryRequest = z.infer<typeof createCategoryRequestSchema>;

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
export type UpdateCategoryRequest = z.infer<typeof updateCategoryRequestSchema>;
