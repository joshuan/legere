import { z } from 'zod';

// People a document is about (docs/03 §3.3.19). A shared catalogue: one row per person, however many
// documents name them.
export const personDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  // What tells two people of the same name apart.
  note: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
});
export type PersonDto = z.infer<typeof personDtoSchema>;

export const listPeopleResponseSchema = z.object({ items: z.array(personDtoSchema) });
export type ListPeopleResponse = z.infer<typeof listPeopleResponseSchema>;

export const createPersonRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).nullable().optional(),
});
export type CreatePersonRequest = z.infer<typeof createPersonRequestSchema>;

// Four rows for one person become one (docs/03 §3.3.19). The name is chosen rather than derived:
// which spelling is right is exactly the thing a machine got wrong.
export const mergePeopleRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500).nullable().optional(),
});
export type MergePeopleRequest = z.infer<typeof mergePeopleRequestSchema>;

export const updatePersonRequestSchema = createPersonRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdatePersonRequest = z.infer<typeof updatePersonRequestSchema>;
