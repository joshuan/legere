import { z } from 'zod';
import { catalogueReadingStateSchema, listCatalogueQuerySchema, paginatedSchema } from './common';

// The note's own contract limit (docs/07 §7.3): a subject's note is a paragraph rather than a line,
// because the analysis reads it to recognise the thing (docs/03 §3.3.20).
export const SUBJECT_NOTE_LIMIT = 2000;

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
  // The newest `documentDate` among the living documents about this thing — an ISO `yyyy-mm-dd`,
  // `null` when none carries a date (docs/07 §7.3, docs/11 §11.12a).
  lastDocumentAt: z.string().nullable(),
});
export type SubjectDto = z.infer<typeof subjectDtoSchema>;

// Sorted and paginated on the people endpoint's terms (docs/07 §7.3).
export const listSubjectsQuerySchema = listCatalogueQuerySchema;
export type ListSubjectsQuery = z.infer<typeof listSubjectsQuerySchema>;

// Paginated like every other list (docs/07 §7.1, SEC-56).
export const listSubjectsResponseSchema = paginatedSchema(subjectDtoSchema);
export type ListSubjectsResponse = z.infer<typeof listSubjectsResponseSchema>;

export const createSubjectRequestSchema = z.object({
  // The kind is chosen from the catalogue, never spelled here: a kind is created by creating one
  // (POST /api/subject-kinds), which is open to anyone signed in.
  kindId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  // How to recognise this one: the address, the plate, the account number, the other party — the
  // things a document would mention. Read by the analysis, so it is a paragraph rather than a line
  // (docs/03 §3.3.20).
  note: z.string().trim().max(SUBJECT_NOTE_LIMIT).nullable().optional(),
});
export type CreateSubjectRequest = z.infer<typeof createSubjectRequestSchema>;

// Four rows for one flat become one (docs/03 §3.3.20). The kind travels too: the rows being merged
// may disagree about it, and the survivor has to be filed somewhere definite.
export const mergeSubjectsRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
  kindId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(SUBJECT_NOTE_LIMIT).nullable().optional(),
});
export type MergeSubjectsRequest = z.infer<typeof mergeSubjectsRequestSchema>;

export const updateSubjectRequestSchema = createSubjectRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateSubjectRequest = z.infer<typeof updateSubjectRequestSchema>;

// One thing the analyst recognised across several rows (docs/05 §5.6c), kind-aware: the group may
// fold rows across duplicate kinds, and `kindId` is the kind the survivor keeps — always one the
// merged rows already have, because the merge endpoint will not invent a shelf. `note` is the
// composed note the survivor should carry (docs/11 §11.12a), `null` when the analyst offered none.
export const subjectMergeSuggestionGroupSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
  name: z.string().min(1).max(200),
  kindId: z.string().uuid(),
  aka: z.array(z.string().min(1).max(200)).max(20),
  note: z.string().max(SUBJECT_NOTE_LIMIT).nullable(),
});
export type SubjectMergeSuggestionGroup = z.infer<typeof subjectMergeSuggestionGroupSchema>;

// `placeholders` are living rows whose name is a kind rather than a thing — analysis noise offered
// for deletion, one confirmed row at a time (docs/03 §3.3.20). `computedAt` on the people
// endpoint's terms (docs/05 §5.6c): when the cached reading was computed, `null` without one.
export const subjectMergeSuggestionsResponseSchema = z.object({
  state: catalogueReadingStateSchema,
  computedAt: z.string().nullable(),
  groups: z.array(subjectMergeSuggestionGroupSchema).max(20),
  placeholders: z.array(z.string().uuid()).max(20),
});
export type SubjectMergeSuggestionsResponse = z.infer<typeof subjectMergeSuggestionsResponseSchema>;

export const subjectMergePreviewRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
});
export type SubjectMergePreviewRequest = z.infer<typeof subjectMergePreviewRequestSchema>;

// `kindId` may be null while the name is not: a tidy spelling with an unresolvable kind still
// beats a raw dump, and the dialog then keeps the kind it opened with. `note` is the composed note
// of docs/05 §5.6c, bounded by the note's own contract limit, `null` when the analyst composed none.
export const subjectMergePreviewResponseSchema = z.object({
  available: z.boolean(),
  name: z.string().min(1).max(200).nullable(),
  kindId: z.string().uuid().nullable(),
  aka: z.array(z.string().min(1).max(200)).max(20).nullable(),
  note: z.string().max(SUBJECT_NOTE_LIMIT).nullable().optional(),
});
export type SubjectMergePreviewResponse = z.infer<typeof subjectMergePreviewResponseSchema>;
