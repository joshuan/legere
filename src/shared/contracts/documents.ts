import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import {
  valueSourceSchema,
  documentEventTypeSchema,
  fileOriginSchema,
  fileRefStatusSchema,
  stepSkipReasonSchema,
  stepStatusSchema,
} from './enums';

// Document contracts (docs/07 §7.3).

// The five steps of docs/05 §5.5, named the way the API and the UI refer to them.
export const documentStepSchema = z.enum([
  'canonical',
  'preview',
  'markdown',
  'analysis',
  'vectorization',
]);
export type DocumentStep = z.infer<typeof documentStepSchema>;

export const DOCUMENT_STEPS: readonly DocumentStep[] = documentStepSchema.options;

// Derived, never stored (docs/03 §3.3.10): a LIBRARY document is available while at least one of its
// files is still on a mounted volume.
// Whether the originals behind a document can be read right now (docs/03 §3.3.10). PARTIAL is the
// honest middle: some files of it are on a volume nobody can reach, and the rest are here.
// The canonical PDF reads either way.
export const availabilitySchema = z.enum(['AVAILABLE', 'PARTIAL', 'UNAVAILABLE']);
export type Availability = z.infer<typeof availabilitySchema>;

export const documentCategorySchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
});

export const documentListDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  // How many files the document is made of, and what they weigh together (docs/07 §7.3).
  fileCount: z.number().int().positive(),
  // The extension of the first file: what the card puts on its badge. Empty when it has none.
  primaryExt: z.string(),
  sizeBytes: z.string(),
  // Pages of the canonical PDF; null until it has been built.
  pageCount: z.number().int().nullable(),
  documentType: documentCategorySchema.nullable(),
  availability: availabilitySchema,
  processing: z.boolean(),
  // LIBRARY when any file of it sits on a volume, MANAGED otherwise (docs/03 §3.3.10).
  origin: fileOriginSchema,
  hasPreview: z.boolean(),
  createdAt: z.string().datetime(),
});
export type DocumentListDto = z.infer<typeof documentListDtoSchema>;

export const documentStepsSchema = z.object({
  canonical: stepStatusSchema,
  preview: stepStatusSchema,
  markdown: stepStatusSchema,
  analysis: stepStatusSchema,
  vectorization: stepStatusSchema,
});

// Where a document's bytes live, as far as the caller may know: refs in libraries they cannot see
// are omitted entirely (docs/07 §7.3).
export const documentFileRefSchema = z.object({
  libraryId: z.string().uuid(),
  libraryName: z.string(),
  path: z.string(),
  status: fileRefStatusSchema,
});

// Why a step is SKIPPED, per step; absent for steps that ran (docs/03 §3.3.10).
// A file inside a document (docs/07 §7.3, docs/03 §3.3.16).
export const cropPointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
export const cropSchema = z.object({
  // Clockwise from the top-left corner, normalized to 0…1 of the image (docs/05 §5.6).
  points: z.tuple([cropPointSchema, cropPointSchema, cropPointSchema, cropPointSchema]),
});
export type Crop = z.infer<typeof cropSchema>;

export const documentFileDtoSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  name: z.string(),
  mimeType: z.string(),
  ext: z.string(),
  sizeBytes: z.string(),
  origin: fileOriginSchema,
  // Whether these bytes can be read right now — false for a library file whose volume lost it.
  available: z.boolean(),
  isImage: z.boolean(),
  crop: cropSchema.nullable(),
  cropSource: valueSourceSchema,
  // Where the same bytes lie on the volumes the caller can see; empty for a managed file.
  refs: z.array(documentFileRefSchema),
  // The other half of the same question, for the file that has no volume: the key a MANAGED file's
  // bytes lie under in the object storage (docs/09 §9.2). Null for a library file, whose location is
  // its `refs`. Between the two, every file says where it is.
  //
  // 🔒 A location, not a way in: the key names an object in a private bucket and grants nothing
  // without a signed URL, which only an endpoint that has already passed the access check issues.
  // It also says nothing the caller was not already told — the layout is `files/{fileId}/original.{ext}`
  // and both halves are on this very DTO.
  storageKey: z.string().nullable(),
});
export type DocumentFileDto = z.infer<typeof documentFileDtoSchema>;

export const documentSkipReasonsSchema = z.record(documentStepSchema, stepSkipReasonSchema);
export type DocumentSkipReasons = z.infer<typeof documentSkipReasonsSchema>;

// What the pipeline worked out, kept beside what the document now says. A person may correct any of
// it; the machine's answer is not thrown away, so the viewer can show "we read X, you made it Y"
// and a wrong correction is never a dead end (docs/03 §3.3.10).
// yyyy-mm-dd, and a real date: 2026-02-31 parses as a string and means nothing.
const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Not a calendar date');

export const autoValuesSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  date: z.string().optional(),
  // What the analysis read a document to be about, whether or not it became a link.
  subjects: z.array(z.object({ kind: z.string(), name: z.string() })).optional(),
  // Names as the analyst read them, whether or not they became links (docs/03 §3.3.10).
  people: z.array(z.string()).optional(),
  typeSlug: z.string().nullish(),
  languages: z.array(z.string()).optional(),
  country: z.string().nullish(),
  city: z.string().nullish(),
});
export type AutoValues = z.infer<typeof autoValuesSchema>;

export const documentDetailDtoSchema = documentListDtoSchema.extend({
  auto: autoValuesSchema,
  // Who the document is about (docs/03 §3.3.19), in catalogue order. `deleted` says the catalogue
  // no longer holds this name: the link deliberately survives a deletion, so the only way to tell a
  // name that is still a choice from one that is a record is to be told.
  people: z.array(z.object({ id: z.string().uuid(), name: z.string(), deleted: z.boolean() })),
  // The date on the document, yyyy-mm-dd. Null when it has none, or none was found.
  documentDate: z.string().nullable(),
  // What the document is about (docs/03 §3.3.20); `deleted` as for people above. The kind travels by
  // id as well as by name, because it is a row of its own (§3.3.20a) and a screen showing a subject
  // shows both halves — and each half is a way into the documents filed under it (docs/11 §11.5).
  subjects: z.array(
    z.object({
      id: z.string().uuid(),
      kindId: z.string().uuid(),
      kind: z.string(),
      name: z.string(),
      deleted: z.boolean(),
    }),
  ),
  ocrUsed: z.boolean(),
  // What this document is, in a few hundred characters (docs/03 §3.3.10).
  description: z.string().nullable(),
  titleSource: valueSourceSchema,
  typeSource: valueSourceSchema,
  steps: documentStepsSchema,
  skipReasons: documentSkipReasonsSchema,
  // BCP-47 tags, most likely first (docs/03 §3.3.10).
  languages: z.array(z.string()),
  // ISO 3166-1 alpha-2, and the city as the document writes it.
  country: z.string().nullable(),
  city: z.string().nullable(),
  processingError: z.string().nullable(),
  failedStep: z.string().nullable(),
  files: z.array(documentFileDtoSchema),
  createdBy: z.object({ id: z.string().uuid(), displayName: z.string() }).nullable(),
});
export type DocumentDetailDto = z.infer<typeof documentDetailDtoSchema>;

// Query strings arrive as strings; booleans are spelled out rather than coerced, so `?processing=0`
// cannot silently mean true.
const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

// How a shelf may be arranged (docs/07 §7.1, docs/11 §11.3). A closed set of named orders, not an
// arbitrary sort parameter: each one names a column the schema carries an index for, and a name the
// enum does not hold is a validation failure rather than a slow query.
//
// - `documentDate` — the date written on the paper (docs/03 §3.3.10), newest first, and the undated
//   *before* everything: a document whose date nobody has read yet is the one still wanting
//   attention, and burying it under a century of dated ones is how it stays unread.
// - `createdAt` — when Legere first saw it. The order every list had before this existed.
// - `lastEventAt` — the newest entry in the document's journal, whatever kind (docs/03 §3.3.18).
//   Deliberately *not* `updatedAt`, which the pipeline bumps whenever it rewrites a step status and
//   which two raw writes skip entirely: it is an honest "row touched" and a dishonest "edited".
export const documentSortSchema = z.enum(['documentDate', 'createdAt', 'lastEventAt']);
export type DocumentSort = z.infer<typeof documentSortSchema>;

export const DOCUMENT_SORTS: readonly DocumentSort[] = documentSortSchema.options;

// The shelf as somebody keeps it, not as a machine filled it: the date on the paper.
export const DEFAULT_DOCUMENT_SORT: DocumentSort = 'documentDate';

export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  sort: documentSortSchema.default(DEFAULT_DOCUMENT_SORT),
  libraryId: z.string().uuid().optional(),
  typeId: z.string().uuid().optional(),
  personId: z.string().uuid().optional(),
  subjectId: z.string().uuid().optional(),
  // Every subject of one kind at once — "everything about a flat", whichever flat (docs/03 §3.3.20a).
  subjectKindId: z.string().uuid().optional(),
  // The year on the document, not the year it was filed (docs/03 §3.3.10).
  year: z.coerce.number().int().min(1900).max(2100).optional(),
  // Where the document is from. ISO 3166-1 alpha-2, upper-cased on the way in like the PATCH does,
  // so `?country=me` and `?country=ME` are one question; the city is matched exactly as stored,
  // which is what a link carrying a document's own place hands over (docs/07 §7.3).
  country: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
  city: z.string().trim().min(1).max(120).optional(),
  availability: availabilitySchema.optional(),
  processing: queryBoolean,
  origin: fileOriginSchema.optional(),
  // A pipeline step and the status it sits in, given together: what a queue counter links to
  // (docs/07 §7.3, docs/11 §11.13). Either alone is a validation failure — half the question.
  step: documentStepSchema.optional(),
  stepStatus: stepStatusSchema.optional(),
});
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;

export const listDocumentsResponseSchema = paginatedSchema(documentListDtoSchema);

// The years documents carry, newest first, with how many each holds — the folders of a shelf
// arranged by date (docs/07 §7.3).
export const documentYearsResponseSchema = z.object({
  items: z.array(z.object({ year: z.number().int(), count: z.number().int().nonnegative() })),
});
export type DocumentYearsResponse = z.infer<typeof documentYearsResponseSchema>;

// POST /api/documents — an upload (docs/05 §5.1a). `created: false` means the content was already
// here and the caller was allowed to see it, so this is the document it resolved to.
export const uploadDocumentResponseSchema = z.object({
  document: documentListDtoSchema,
  created: z.boolean(),
});
export type UploadDocumentResponse = z.infer<typeof uploadDocumentResponseSchema>;
export type ListDocumentsResponse = z.infer<typeof listDocumentsResponseSchema>;

// `typeId: null` clears the documentType; absent leaves it alone (docs/07 §7.4).
// The fields a machine fills in and a person may therefore want back the way it had them.
export const RESETTABLE_FIELDS = [
  'title',
  'description',
  'documentType',
  'languages',
  'country',
  'city',
  'documentDate',
] as const;
export const resettableFieldSchema = z.enum(RESETTABLE_FIELDS);
export type ResettableField = z.infer<typeof resettableFieldSchema>;

export const updateDocumentRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    // A paragraph, not an essay: this is read at a glance, and null clears it so the analysis may
    // answer again (docs/03 §3.3.10).
    description: z.string().trim().max(1000).nullable().optional(),
    typeId: z.string().uuid().nullable().optional(),
    // BCP-47, loosely: `ru`, `en`, `sr-Latn`. Kept short so a typo cannot become a novel.
    languages: z.array(z.string().trim().min(2).max(12)).max(5).optional(),
    // ISO 3166-1 alpha-2, upper-cased; null clears it.
    country: z
      .string()
      .trim()
      .length(2)
      .transform((value) => value.toUpperCase())
      .nullable()
      .optional(),
    city: z.string().trim().min(1).max(120).nullable().optional(),
    // The whole set, not a diff: the form sends what the document should end up with. A document
    // rarely names more than a few people, so a cap that low is a typo detector, not a limit.
    peopleIds: z.array(z.string().uuid()).max(20).optional(),
    documentDate: isoDateSchema.nullable().optional(),
    subjectIds: z.array(z.string().uuid()).max(20).optional(),
    // Put a field back to what the pipeline read. Not the same as sending that value by hand: a
    // reset documentType becomes AUTO again, so it stops claiming a person chose it (docs/03 §3.3.10).
    reset: z.array(resettableFieldSchema).min(1).max(RESETTABLE_FIELDS.length).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

// One entry of a document's history (docs/03 §3.3.18). The payload is deliberately loose: each type
// uses a different few fields, and a log must never fail to render because one entry is odd.
export const documentEventDtoSchema = z.object({
  id: z.string().uuid(),
  type: documentEventTypeSchema,
  at: z.string(),
  // Null is the pipeline acting on its own.
  actor: z.string().nullable(),
  payload: z.object({
    step: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
    error: z.string().optional(),
    steps: z.array(z.string()).optional(),
    // Which service did the step, and the id it was asked under — both entries of a started/finished
    // pair carry the same one (docs/03 §3.3.18). The host is an admin's to see.
    service: z.string().optional(),
    endpoint: z.string().optional(),
    requestId: z.string().optional(),
    source: z.string().optional(),
    library: z.string().optional(),
    path: z.string().optional(),
    changes: z
      .record(z.object({ from: z.string().nullish(), to: z.string().nullish() }))
      .optional(),
  }),
});
export type DocumentEventDto = z.infer<typeof documentEventDtoSchema>;

export const documentEventPageSchema = z.object({
  items: z.array(documentEventDtoSchema),
  nextCursor: z.string().nullable(),
});
export type DocumentEventPage = z.infer<typeof documentEventPageSchema>;

// An absent or empty list means the whole pipeline (docs/07 §7.3).
export const reprocessRequestSchema = z.object({
  steps: z.array(documentStepSchema).min(1).max(DOCUMENT_STEPS.length).optional(),
});
export type ReprocessRequest = z.infer<typeof reprocessRequestSchema>;

export const reprocessResponseSchema = z.object({
  documentId: z.string().uuid(),
  steps: z.array(documentStepSchema),
});
export type ReprocessResponse = z.infer<typeof reprocessResponseSchema>;

export const documentMarkdownResponseSchema = z.object({ markdown: z.string().nullable() });
export type DocumentMarkdownResponse = z.infer<typeof documentMarkdownResponseSchema>;
