import { z } from 'zod';
import { paginationQuerySchema } from './common';
import { receiptListItemSchema } from './receipts';

export const receiptMatchReasonSchema = z.enum([
  'date',
  'total',
  'merchant',
  'taxId',
  'number',
  'time',
  'card',
  'items',
]);
export type ReceiptMatchReason = z.infer<typeof receiptMatchReasonSchema>;
export const receiptMatchConflictSchema = z.enum([
  'date',
  'total',
  'currency',
  'merchant',
  'taxId',
  'number',
  'time',
  'card',
  'items',
]);
export type ReceiptMatchConflict = z.infer<typeof receiptMatchConflictSchema>;
export const receiptMatchKindSchema = z.enum(['duplicate', 'parts', 'possible', 'manual']);
export type ReceiptMatchKind = z.infer<typeof receiptMatchKindSchema>;

export const receiptPairQuerySchema = z
  .object({
    firstId: z.string().uuid(),
    secondId: z.string().uuid(),
  })
  .refine((value) => value.firstId !== value.secondId, 'Choose two different receipts');
export type ReceiptPairQuery = z.infer<typeof receiptPairQuerySchema>;

export const receiptDuplicatePairSchema = z.object({
  first: receiptListItemSchema,
  second: receiptListItemSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  kind: receiptMatchKindSchema,
  reasons: z.array(receiptMatchReasonSchema),
  conflicts: z.array(receiptMatchConflictSchema),
  mergeBlocked: z.enum(['preview', 'pages', 'size']).nullable(),
});
export type ReceiptDuplicatePair = z.infer<typeof receiptDuplicatePairSchema>;
export const receiptDuplicateQuerySchema = paginationQuerySchema;
export type ReceiptDuplicateQuery = z.infer<typeof receiptDuplicateQuerySchema>;
export const receiptDuplicatePageSchema = z.object({
  items: z.array(receiptDuplicatePairSchema),
  nextCursor: z.string().nullable(),
  checkedPairs: z.number().int().nonnegative(),
});
export type ReceiptDuplicatePage = z.infer<typeof receiptDuplicatePageSchema>;

export const receiptReviewActionSchema = z.enum(['DISMISS', 'KEEP_FIRST', 'KEEP_SECOND', 'MERGE']);
export type ReceiptReviewAction = z.infer<typeof receiptReviewActionSchema>;
export const resolveReceiptPairSchema = z
  .object({
    operationId: z.string().uuid(),
    firstId: z.string().uuid(),
    secondId: z.string().uuid(),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    action: receiptReviewActionSchema,
    reverse: z.boolean().default(false),
  })
  .refine((value) => value.firstId < value.secondId, 'Use the ordered pair returned by comparison')
  .refine((value) => !value.reverse || value.action === 'MERGE', 'Only a merge has page order');
export type ResolveReceiptPair = z.infer<typeof resolveReceiptPairSchema>;

export const receiptReviewSchema = z.object({
  id: z.string().uuid(),
  action: receiptReviewActionSchema,
  reverse: z.boolean(),
  pair: receiptDuplicatePairSchema,
  resultId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  undoneAt: z.string().datetime().nullable(),
  actor: z.object({ id: z.string().uuid(), displayName: z.string() }),
});
export type ReceiptReviewDto = z.infer<typeof receiptReviewSchema>;
export const receiptReviewPageSchema = z.object({
  items: z.array(receiptReviewSchema),
  nextCursor: z.string().nullable(),
});
export type ReceiptReviewPage = z.infer<typeof receiptReviewPageSchema>;
