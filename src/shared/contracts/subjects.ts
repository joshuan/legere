import { z } from 'zod';

// What a document is about (docs/03 §3.3.20): the kind of thing, and which one. The kind is a row of
// its own (§3.3.20a); it travels by id, and by name too, because every screen that shows a subject
// shows both halves and should not have to join two lists to do it.
export const subjectDtoSchema = z.object({
  id: z.string().uuid(),
  kindId: z.string().uuid(),
  kind: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
});
export type SubjectDto = z.infer<typeof subjectDtoSchema>;

export const listSubjectsResponseSchema = z.object({ items: z.array(subjectDtoSchema) });
export type ListSubjectsResponse = z.infer<typeof listSubjectsResponseSchema>;

export const createSubjectRequestSchema = z.object({
  // The kind is chosen from the catalogue, never spelled here: a kind is created by creating one
  // (POST /api/subject-kinds), which is open to anyone signed in.
  kindId: z.string().uuid(),
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
