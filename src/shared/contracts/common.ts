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
  'SCANSET_NOT_FOUND',
  'INVITE_NOT_FOUND',
  'EMAIL_ALREADY_REGISTERED',
  'LAST_ADMIN',
  'LIBRARY_PATH_CONFLICT',
  'DOCUMENT_TYPE_SLUG_TAKEN',
  'PERSON_EXISTS',
  'PERSON_NOT_FOUND',
  'DOCUMENT_DUPLICATE',
  'COLLECTION_NAME_TAKEN',
  'SCANSET_INVALID_STATE',
  'DOCUMENT_UNAVAILABLE',
  'ONBOARDING_CLOSED',
  'VALIDATION_FAILED',
  'LIBRARY_PATH_INVALID',
  'SCANSET_ITEM_NOT_IMAGE',
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
