import { z } from 'zod';
import { catalogueReadingStateSchema, paginatedSchema } from './common';

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

// Paginated like every other list (docs/07 §7.1, SEC-56): the catalogue is instance-wide and
// user-written, so no single response may be asked to carry the whole of it.
export const listPeopleResponseSchema = paginatedSchema(personDtoSchema);
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

// One person the analyst recognised across several rows (docs/05 §5.6c): the rows it would fold,
// the spelling it would keep, the distinct other spellings for the survivor's note. The bounds are
// the merge contract's own — a group the merge endpoint would refuse is not a suggestion.
export const mergeSuggestionGroupSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
  name: z.string().min(1).max(200),
  aka: z.array(z.string().min(1).max(200)).max(20),
});
export type MergeSuggestionGroup = z.infer<typeof mergeSuggestionGroupSchema>;

// A state, not an error (docs/07 §7.3): without an analyst the screen simply has no banner, and an
// analyst that could not be asked says so rather than passing an outage off as an empty catalogue.
export const peopleMergeSuggestionsResponseSchema = z.object({
  state: catalogueReadingStateSchema,
  groups: z.array(mergeSuggestionGroupSchema).max(20),
});
export type PeopleMergeSuggestionsResponse = z.infer<typeof peopleMergeSuggestionsResponseSchema>;

// The same reading for rows an admin selected by hand, so the merge dialog opens tidy
// (docs/11 §11.12a).
export const peopleMergePreviewRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
});
export type PeopleMergePreviewRequest = z.infer<typeof peopleMergePreviewRequestSchema>;

// `available: false` sends the dialog back to its raw prefill — an unconfigured analyst and an
// unreadable answer degrade the same way.
export const peopleMergePreviewResponseSchema = z.object({
  available: z.boolean(),
  name: z.string().min(1).max(200).nullable(),
  aka: z.array(z.string().min(1).max(200)).max(20).nullable(),
});
export type PeopleMergePreviewResponse = z.infer<typeof peopleMergePreviewResponseSchema>;
