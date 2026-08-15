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
  'DOCUMENT_DUPLICATE',
  // 🔒 An upload the pipeline could never render is refused at the door (docs/05 §5.1a); a library
  // file of the same kind is merely registered, because a scan has nobody to answer.
  'UNSUPPORTED_FORMAT',
  'COLLECTION_NAME_TAKEN',
  // 🔒 A document is emptied by deleting it, not by taking its parts away (docs/03 §3.3.10).
  'DOCUMENT_LAST_FILE',
  'FILE_ALREADY_IN_DOCUMENT',
  // The edges between documents (docs/03 §3.3.23): one per pair, never to itself, and gone is gone.
  'LINK_EXISTS',
  'LINK_NOT_FOUND',
  'LINK_SELF',
  'CANONICAL_NOT_READY',
  'DOCUMENT_UNAVAILABLE',
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

// GET /api/health (docs/07 §7.3, docs/06 §6.10).
export const healthDataSchema = z.object({
  status: z.enum(['ok', 'error']),
  db: z.enum(['ok', 'down']),
  queue: z.enum(['ok', 'down']),
});
export type HealthData = z.infer<typeof healthDataSchema>;
