import { z } from 'zod';

// What a document is about (docs/03 §3.3.20): the kind of thing, and which one.
export const subjectDtoSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
});
export type SubjectDto = z.infer<typeof subjectDtoSchema>;

export const listSubjectsResponseSchema = z.object({ items: z.array(subjectDtoSchema) });
export type ListSubjectsResponse = z.infer<typeof listSubjectsResponseSchema>;

export const createSubjectRequestSchema = z.object({
  // Lower-cased on the way in: "Apartment" and "apartment" are one kind, and a catalogue that
  // disagrees with itself about capitalisation is a catalogue with two of everything.
  kind: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreateSubjectRequest = z.infer<typeof createSubjectRequestSchema>;

export const updateSubjectRequestSchema = createSubjectRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateSubjectRequest = z.infer<typeof updateSubjectRequestSchema>;
