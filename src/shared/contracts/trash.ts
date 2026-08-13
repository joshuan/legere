import { z } from 'zod';
import { paginationQuerySchema } from './common';
import { documentFileRefSchema } from './documents';
import { fileOriginSchema, trashReasonSchema } from './enums';

// The trash (docs/07 §7.3 admin trash, docs/05 §5.7a, docs/11 §11.13b): every file that has left a
// document and has not yet been destroyed. A file is in exactly one document or in here.

export const trashItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  mimeType: z.string(),
  ext: z.string(),
  sizeBytes: z.string(),
  origin: fileOriginSchema,
  // Whether the bytes can still be read — a library original whose volume lost it cannot, and there
  // is then nothing to download and nothing to restore.
  available: z.boolean(),
  isImage: z.boolean(),
  reason: trashReasonSchema,
  trashedAt: z.string().datetime(),
  // The title the document had when the file left it. A record rather than a link: that document is
  // usually gone by the time anybody reads this.
  trashedFrom: z.string().nullable(),
  // 🔒 When the sweep will delete it — and `null` for a LIBRARY file, which no sweep will ever
  // delete because its bytes are on a read-only volume (ADR-007). The client says so in words
  // instead of showing a date that will never arrive.
  purgeAfter: z.string().datetime().nullable(),
  // Where the bytes lie: on the volumes the caller can see, or under this key in our own bucket —
  // the same pair of answers a file of a document gives (docs/09 §9.2).
  refs: z.array(documentFileRefSchema),
  storageKey: z.string().nullable(),
});
export type TrashItemDto = z.infer<typeof trashItemSchema>;

export const listTrashQuerySchema = paginationQuerySchema;
export type ListTrashQuery = z.infer<typeof listTrashQuerySchema>;

export const listTrashResponseSchema = z.object({
  items: z.array(trashItemSchema),
  nextCursor: z.string().nullable(),
  // The whole trash, not this page: "what is this costing me" is why the screen is opened at all.
  total: z.object({
    items: z.number().int().nonnegative(),
    bytes: z.string(),
  }),
});
export type ListTrashResponse = z.infer<typeof listTrashResponseSchema>;

export const emptyTrashResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});
export type EmptyTrashResponse = z.infer<typeof emptyTrashResponseSchema>;

// A restored file becomes a document of its own — a new one, never the document it came from
// (docs/05 §5.7a), so the answer is where to go and look at it.
export const restoreTrashResponseSchema = z.object({
  documentId: z.string().uuid(),
});
export type RestoreTrashResponse = z.infer<typeof restoreTrashResponseSchema>;
