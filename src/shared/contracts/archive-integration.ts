import { z } from 'zod';
import { documentStepsSchema } from './documents';

export const archiveSubjectSchema = z
  .object({
    subject: z.string().uuid(),
    displayName: z.string(),
  })
  .strict();
export const archiveDocumentSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    createdAt: z.string().datetime(),
    documentDate: z.string().date().nullable(),
    pageCount: z.number().int().nonnegative().nullable(),
    documentType: z
      .object({ id: z.string().uuid(), slug: z.string(), name: z.string() })
      .strict()
      .nullable(),
    processing: z.boolean(),
    steps: documentStepsSchema,
    url: z.string().url(),
  })
  .strict();
export type ArchiveDocumentDto = z.infer<typeof archiveDocumentSchema>;
export const archiveDocumentListSchema = z
  .object({
    items: z.array(archiveDocumentSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const archiveDocumentsQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .max(300)
      .refine((value) => !value.includes('\u0000'))
      .default(''),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type ArchiveDocumentsQuery = z.infer<typeof archiveDocumentsQuerySchema>;
