import {
  collectionDetailResponseSchema,
  collectionDtoSchema,
  collectionShareDtoSchema,
  listCollectionSharesResponseSchema,
  listCollectionsResponseSchema,
  type CollectionDetailResponse,
  type CollectionDto,
  type CollectionShareDto,
  type CreateCollectionRequest,
  type ListCollectionSharesResponse,
  type ListCollectionsResponse,
  type UpdateCollectionRequest,
} from '../../../shared/contracts/collections';
import {
  okResponseSchema,
  userLookupResponseSchema,
  type OkResponse,
  type UserLookupResponse,
} from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// Collection endpoints (docs/07 §7.3).
export const collectionApi = {
  list: (): Promise<ListCollectionsResponse> =>
    apiClient.get('/api/collections', { schema: listCollectionsResponseSchema }),

  get: (id: string, cursor?: string): Promise<CollectionDetailResponse> =>
    apiClient.get(`/api/collections/${id}`, {
      schema: collectionDetailResponseSchema,
      ...(cursor === undefined ? {} : { query: { cursor } }),
    }),

  create: (body: CreateCollectionRequest): Promise<CollectionDto> =>
    apiClient.post('/api/collections', { schema: collectionDtoSchema, body }),

  update: (id: string, body: UpdateCollectionRequest): Promise<CollectionDto> =>
    apiClient.patch(`/api/collections/${id}`, { schema: collectionDtoSchema, body }),

  remove: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/collections/${id}`, { schema: okResponseSchema }),

  addItem: (id: string, documentId: string): Promise<OkResponse> =>
    apiClient.post(`/api/collections/${id}/items`, {
      schema: okResponseSchema,
      body: { documentId },
    }),

  removeItem: (id: string, documentId: string): Promise<OkResponse> =>
    apiClient.delete(`/api/collections/${id}/items/${documentId}`, { schema: okResponseSchema }),

  shares: (id: string): Promise<ListCollectionSharesResponse> =>
    apiClient.get(`/api/collections/${id}/shares`, { schema: listCollectionSharesResponseSchema }),

  share: (id: string, granteeUserId: string | null): Promise<CollectionShareDto> =>
    apiClient.post(`/api/collections/${id}/shares`, {
      schema: collectionShareDtoSchema,
      body: { granteeUserId },
    }),

  revokeShare: (id: string, shareId: string): Promise<OkResponse> =>
    apiClient.delete(`/api/collections/${id}/shares/${shareId}`, { schema: okResponseSchema }),

  lookupUsers: (q: string): Promise<UserLookupResponse> =>
    apiClient.get('/api/users/lookup', { schema: userLookupResponseSchema, query: { q } }),
};

export const collectionKeys = {
  all: ['collections'] as const,
  detail: (id: string) => ['collection', id] as const,
  shares: (id: string) => ['collection', id, 'shares'] as const,
  lookup: (q: string) => ['users', 'lookup', q] as const,
};
