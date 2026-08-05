import { z } from 'zod';

// What sort of thing a subject is (docs/03 §3.3.20a): a catalogue, so that renaming "flat" to
// "apartment" is one edit rather than forty.
export const subjectKindDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  note: z.string().nullable(),
  // How many things of this kind the catalogue holds, and how many documents they are on between
  // them — a kind is worth keeping for what hangs off it.
  subjectCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
});
export type SubjectKindDto = z.infer<typeof subjectKindDtoSchema>;

export const listSubjectKindsResponseSchema = z.object({ items: z.array(subjectKindDtoSchema) });
export type ListSubjectKindsResponse = z.infer<typeof listSubjectKindsResponseSchema>;

export const createSubjectKindRequestSchema = z.object({
  // Stored exactly as it is typed, in whatever language and case the owner files by — "Квартира"
  // is a kind, and turning it into "apartment" is the product deciding how somebody's archive is
  // spelled. Uniqueness stays case-insensitive, so it is still one kind (docs/03 §3.3.20a).
  name: z.string().trim().min(1).max(40),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreateSubjectKindRequest = z.infer<typeof createSubjectKindRequestSchema>;

export const updateSubjectKindRequestSchema = createSubjectKindRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateSubjectKindRequest = z.infer<typeof updateSubjectKindRequestSchema>;
