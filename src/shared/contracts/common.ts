import { z } from 'zod';

// Machine error codes (docs/07 §7.2). The UI localizes by `code`; `message` is a developer hint only.
export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'NOT_FOUND',
  'USER_NOT_FOUND',
  'LIBRARY_NOT_FOUND',
  'DOCUMENT_NOT_FOUND',
  'DOCUMENT_TYPE_NOT_FOUND',
  'COLLECTION_NOT_FOUND',
  'FILE_NOT_FOUND',
  // A page of another document, or of none at all (docs/03 §3.3.17): an entry is addressed inside
  // the document that holds it, so one that is not this document's is simply not there.
  'PAGE_NOT_FOUND',
  'INVITE_NOT_FOUND',
  'API_TOKEN_NOT_FOUND',
  // 🔒 Somebody else's session is not found rather than forbidden: that it exists at all is none
  // of the caller's business (docs/08 §8.2).
  'SESSION_NOT_FOUND',
  // 🔒 A bearer token may read and nothing else, refused before routing (docs/08 §8.2a).
  'READ_ONLY_TOKEN',
  'EMAIL_ALREADY_REGISTERED',
  'LAST_ADMIN',
  'LIBRARY_PATH_CONFLICT',
  'DOCUMENT_TYPE_SLUG_TAKEN',
  'PERSON_EXISTS',
  'PERSON_NOT_FOUND',
  'SUBJECT_EXISTS',
  'SUBJECT_NOT_FOUND',
  'SUBJECT_KIND_EXISTS',
  'SUBJECT_KIND_NOT_FOUND',
  // 🔒 A subject with no kind is not a thing anybody can file by, so the subjects go first
  // (docs/03 §3.3.20a).
  'SUBJECT_KIND_IN_USE',
  // 🔒 The instance ceiling behind the catalogue throttle (docs/08 §8.4, SEC-51, SEC-56): a create
  // that would push a catalogue past its fixed count of living rows. Merges and deletes make room
  // again, so recovery is the admin's ordinary tidying tools.
  'CATALOGUE_FULL',
  'DOCUMENT_DUPLICATE',
  // 🔒 An upload the pipeline could never render is refused at the door (docs/05 §5.1a); a library
  // file of the same kind is merely registered, because a scan has nobody to answer.
  'UNSUPPORTED_FORMAT',
  'COLLECTION_NAME_TAKEN',
  // 🔒 A document is emptied by deleting it, not by taking its parts away (docs/03 §3.3.10).
  'DOCUMENT_LAST_FILE',
  // The same rule counted in pages (docs/05 §5.6): removing the last one, moving every one of them
  // away, or cutting at a boundary that would leave a part with nothing in it.
  'DOCUMENT_LAST_PAGE',
  // 🔒 A document a scan made has no creator, so its readers are the people its libraries reach
  // (docs/03 §3.4a): a composition that would leave it holding no library page would leave it
  // readable to an admin and to nobody else, and is refused before it is written (docs/05 §5.6).
  'DOCUMENT_WOULD_HAVE_NO_READERS',
  // 🔒 And the bound at the other end (docs/05 §5.4a): every file of a document is opened, converted
  // and held at once by the canonical build, so how many of them there are is a decision rather than
  // whatever the disk allows.
  'DOCUMENT_TOO_MANY_FILES',
  'FILE_ALREADY_IN_DOCUMENT',
  // 🔒 A composition edit rewrites the document's whole page list from the reading it was given, so
  // a reading that has since moved would carry an older list back with it — a page somebody removed
  // written back, reading a file that is now in the trash (docs/03 §3.3.17). Refused instead:
  // nothing is written, and the caller re-reads and asks again.
  'DOCUMENT_CHANGED',
  // 🔒 A replacement reaches every page that reads those bytes, in every document reading them
  // (ADR-025), so it needs the right to destroy content in all of them — combine's rule, for
  // combine's reason (docs/03 §3.4a). Refused whole rather than applied to the part of the archive
  // the caller happens to reach.
  'FILE_READ_ELSEWHERE',
  // The edges between documents (docs/03 §3.3.23): one per pair, never to itself, and gone is gone.
  'LINK_EXISTS',
  'LINK_NOT_FOUND',
  'LINK_SELF',
  'CANONICAL_NOT_READY',
  'DOCUMENT_UNAVAILABLE',
  // 🔒 A step this instance is holding is not run for the asking (docs/05 §5.4d): a reprocess whose
  // every step is paused would enqueue a job that does nothing, so it is refused instead.
  'STEPS_PAUSED',
  'ONBOARDING_CLOSED',
  'VALIDATION_FAILED',
  // 🔒 A cursor names the order it was cut from (docs/07 §7.1). Answering it from another column
  // would silently skip or repeat documents, so the request is refused instead of guessed at.
  'CURSOR_SORT_MISMATCH',
  'LIBRARY_PATH_INVALID',
  'FILE_NOT_IMAGE',
  // The other half of the same rule: only an image is cropped, and only a PDF has pages to put in
  // order (docs/03 §3.3.16).
  'FILE_NOT_PDF',
  'EMAIL_CODE_INVALID',
  'REGISTRATION_TICKET_INVALID',
  'INVITE_INVALID',
  'RESET_INVALID',
  'CAPTCHA_FAILED',
  'RATE_LIMITED',
  'EMAIL_CODE_TOO_MANY_ATTEMPTS',
  'INTERNAL',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = (typeof ERROR_CODES)[number];

// Error envelope (docs/07 §7.1): { error: { code, message, details } }.
export const errorBodySchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().nullable(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

// Success envelope (docs/07 §7.1): { data: ... }.
export type Envelope<T> = { data: T };

export function successEnvelopeSchema<T extends z.ZodTypeAny>(data: T): z.ZodObject<{ data: T }> {
  return z.object({ data });
}

// Cursor pagination (docs/07 §7.1): request ?limit=&cursor=, response { items, nextCursor }.
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(
  item: T,
): z.ZodObject<{ items: z.ZodArray<T>; nextCursor: z.ZodNullable<z.ZodString> }> {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// How a catalogue page may be arranged (docs/07 §7.3, docs/11 §11.12a). A closed set of named
// orders on the documents list's terms (documents.ts): every name is spelled out, and one the enum
// does not hold is a validation failure rather than a sequential scan.
//
// - `lastDocumentAt` — the newest `documentDate` among the living documents that name the row: the
//   catalogue opens on what the archive most recently spoke of, dateless rows last.
// - `documents` — how many living documents name the row.
// - `name` — the name itself, the order every catalogue had before this existed.
export const catalogueSortSchema = z.enum(['lastDocumentAt', 'documents', 'name']);
export type CatalogueSort = z.infer<typeof catalogueSortSchema>;

// The kinds screen counts two things, so its enum admits one more name: `things` — how many living
// subjects the kind holds (docs/07 §7.3).
export const subjectKindSortSchema = z.enum(['lastDocumentAt', 'documents', 'things', 'name']);
export type SubjectKindSort = z.infer<typeof subjectKindSortSchema>;

export const catalogueOrderSchema = z.enum(['asc', 'desc']);
export type CatalogueOrder = z.infer<typeof catalogueOrderSchema>;

// The default the docs name (docs/11 §11.12a): `lastDocumentAt desc`, newest first. One definite
// order whatever the sort, so the server never guesses — a screen sorting by name sends its own
// `order=asc` out loud.
export const DEFAULT_CATALOGUE_SORT: CatalogueSort = 'lastDocumentAt';
export const DEFAULT_CATALOGUE_ORDER: CatalogueOrder = 'desc';

// What the two people-shaped catalogue lists take beside their pagination (docs/07 §7.3); the kinds
// list widens the sort enum in its own file. The cursor stays bound to the sort and order that
// minted it, exactly as the documents list's is (docs/07 §7.1).
export const listCatalogueQuerySchema = paginationQuerySchema.extend({
  sort: catalogueSortSchema.default(DEFAULT_CATALOGUE_SORT),
  order: catalogueOrderSchema.default(DEFAULT_CATALOGUE_ORDER),
});
export type ListCatalogueQuery = z.infer<typeof listCatalogueQuerySchema>;

// The recompute of the suggestions panel (docs/11 §11.12a, docs/05 §5.6c): `?refresh=1` drops the
// in-process cached reading and asks the analyst anew. Spelled out like every query boolean
// (documents.ts): `1` or `0`, so a value the enum does not hold is a validation failure rather than
// a silent false.
export const catalogueSuggestionsQuerySchema = z.object({
  refresh: z
    .enum(['1', '0'])
    .transform((value) => value === '1')
    .optional(),
});
export type CatalogueSuggestionsQuery = z.infer<typeof catalogueSuggestionsQuerySchema>;

// How a reading of a catalogue ended (docs/07 §7.3, docs/05 §5.6c). Three states and not a boolean,
// because two of the silences are not the same silence: an analyst that was asked and proposed
// nothing is a clean catalogue, while an analyst that could not be asked is a fact about the
// instance — and reporting the second as the first is what kept the suggester dead on a live
// instance for months, with a 200 in the log and no banner on the screen. `groups` (and the
// subjects' `placeholders`) are empty unless the state is `ANSWERED`.
export const catalogueReadingStateSchema = z.enum(['ANSWERED', 'UNCONFIGURED', 'UNAVAILABLE']);
export type CatalogueReadingState = z.infer<typeof catalogueReadingStateSchema>;

// GET /api/health (docs/07 §7.3, docs/06 §6.10).
export const healthDataSchema = z.object({
  status: z.enum(['ok', 'error']),
  db: z.enum(['ok', 'down']),
  queue: z.enum(['ok', 'down']),
});
export type HealthData = z.infer<typeof healthDataSchema>;
