import { z } from 'zod';
import { paginatedSchema, paginationQuerySchema } from './common';
import { documentListDtoSchema } from './documents';

// Collection contracts (docs/07 §7.3, docs/03 §3.3.13–3.3.15).

export const collectionDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  ownerId: z.string().uuid(),
  ownerName: z.string(),
  // How the caller comes to see it: their own, or somebody else's shared with them.
  mine: z.boolean(),
  sharedByMe: z.boolean(),
  sharedWithMe: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type CollectionDto = z.infer<typeof collectionDtoSchema>;

export const listCollectionsResponseSchema = z.object({ items: z.array(collectionDtoSchema) });
export type ListCollectionsResponse = z.infer<typeof listCollectionsResponseSchema>;

export const createCollectionRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
});
export type CreateCollectionRequest = z.infer<typeof createCollectionRequestSchema>;

export const updateCollectionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });
export type UpdateCollectionRequest = z.infer<typeof updateCollectionRequestSchema>;

export const collectionDetailResponseSchema = z.object({
  collection: collectionDtoSchema,
  // Only the items this viewer may read (docs/03 §3.3.14): each viewer sees the intersection of the
  // collection and their own access.
  items: paginatedSchema(documentListDtoSchema),
});
export type CollectionDetailResponse = z.infer<typeof collectionDetailResponseSchema>;

export const collectionItemsQuerySchema = paginationQuerySchema;
export type CollectionItemsQuery = z.infer<typeof collectionItemsQuerySchema>;

export const addCollectionItemRequestSchema = z.object({ documentId: z.string().uuid() });
export type AddCollectionItemRequest = z.infer<typeof addCollectionItemRequestSchema>;

export const collectionShareDtoSchema = z.object({
  id: z.string().uuid(),
  // null = the whole instance (docs/03 §3.3.15).
  granteeUserId: z.string().uuid().nullable(),
  granteeName: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type CollectionShareDto = z.infer<typeof collectionShareDtoSchema>;

export const listCollectionSharesResponseSchema = z.object({
  items: z.array(collectionShareDtoSchema),
});
export type ListCollectionSharesResponse = z.infer<typeof listCollectionSharesResponseSchema>;

export const createShareRequestSchema = z.object({
  granteeUserId: z.string().uuid().nullable(),
});
export type CreateShareRequest = z.infer<typeof createShareRequestSchema>;
