import { z } from 'zod';
import {
  catalogueOrderSchema,
  catalogueReadingStateSchema,
  DEFAULT_CATALOGUE_ORDER,
  DEFAULT_CATALOGUE_SORT,
  paginatedSchema,
  paginationQuerySchema,
  subjectKindSortSchema,
} from './common';

// The note's own contract limit (docs/07 §7.3).
export const SUBJECT_KIND_NOTE_LIMIT = 500;

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
  // The newest `documentDate` across the living documents about this kind's living things — an ISO
  // `yyyy-mm-dd`, `null` when none carries a date (docs/07 §7.3, docs/11 §11.12a).
  lastDocumentAt: z.string().nullable(),
});
export type SubjectKindDto = z.infer<typeof subjectKindDtoSchema>;

// Sorted and paginated on the people endpoint's terms, `?sort=` admitting `things` here too
// (docs/07 §7.3).
export const listSubjectKindsQuerySchema = paginationQuerySchema.extend({
  sort: subjectKindSortSchema.default(DEFAULT_CATALOGUE_SORT),
  order: catalogueOrderSchema.default(DEFAULT_CATALOGUE_ORDER),
});
export type ListSubjectKindsQuery = z.infer<typeof listSubjectKindsQuerySchema>;

// Paginated like every other list (docs/07 §7.1, SEC-56).
export const listSubjectKindsResponseSchema = paginatedSchema(subjectKindDtoSchema);
export type ListSubjectKindsResponse = z.infer<typeof listSubjectKindsResponseSchema>;

export const createSubjectKindRequestSchema = z.object({
  // Stored exactly as it is typed, in whatever language and case the owner files by — "Квартира"
  // is a kind, and turning it into "apartment" is the product deciding how somebody's archive is
  // spelled. Uniqueness stays case-insensitive, so it is still one kind (docs/03 §3.3.20a).
  name: z.string().trim().min(1).max(40),
  note: z.string().trim().max(SUBJECT_KIND_NOTE_LIMIT).nullable().optional(),
});
export type CreateSubjectKindRequest = z.infer<typeof createSubjectKindRequestSchema>;

export const updateSubjectKindRequestSchema = createSubjectKindRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateSubjectKindRequest = z.infer<typeof updateSubjectKindRequestSchema>;

// Three spellings of one shelf become one (docs/03 §3.3.20a). The name is chosen rather than
// derived, exactly as in the people merge: which spelling is right is the thing the machine got
// wrong.
export const mergeSubjectKindsRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
  name: z.string().trim().min(1).max(40),
  note: z.string().trim().max(SUBJECT_KIND_NOTE_LIMIT).nullable().optional(),
});
export type MergeSubjectKindsRequest = z.infer<typeof mergeSubjectKindsRequestSchema>;

// One shelf the analyst recognised across several rows (docs/05 §5.6c), on the people contract's
// terms: bounds are the merge contract's own, `note` the composed note the survivor should carry
// (docs/11 §11.12a), `null` when the analyst offered none.
export const subjectKindMergeSuggestionGroupSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
  name: z.string().min(1).max(40),
  aka: z.array(z.string().min(1).max(200)).max(20),
  note: z.string().max(SUBJECT_KIND_NOTE_LIMIT).nullable(),
});
export type SubjectKindMergeSuggestionGroup = z.infer<typeof subjectKindMergeSuggestionGroupSchema>;

// `computedAt` on the people endpoint's terms (docs/05 §5.6c): when the cached reading was
// computed, `null` in the two states that carry no reading.
export const subjectKindMergeSuggestionsResponseSchema = z.object({
  state: catalogueReadingStateSchema,
  computedAt: z.string().nullable(),
  groups: z.array(subjectKindMergeSuggestionGroupSchema).max(20),
});
export type SubjectKindMergeSuggestionsResponse = z.infer<
  typeof subjectKindMergeSuggestionsResponseSchema
>;

export const subjectKindMergePreviewRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(2).max(50),
});
export type SubjectKindMergePreviewRequest = z.infer<typeof subjectKindMergePreviewRequestSchema>;

// `note` is the composed note of docs/05 §5.6c, bounded by the note's own contract limit, `null`
// when the analyst composed none.
export const subjectKindMergePreviewResponseSchema = z.object({
  available: z.boolean(),
  name: z.string().min(1).max(40).nullable(),
  aka: z.array(z.string().min(1).max(200)).max(20).nullable(),
  note: z.string().max(SUBJECT_KIND_NOTE_LIMIT).nullable().optional(),
});
export type SubjectKindMergePreviewResponse = z.infer<typeof subjectKindMergePreviewResponseSchema>;
