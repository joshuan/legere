import {
  createApiTokenResponseSchema,
  listApiTokensResponseSchema,
  okResponseSchema,
  type CreateApiTokenRequest,
  type CreateApiTokenResponse,
  type ListApiTokensResponse,
  type OkResponse,
} from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

// A user's own read-only API tokens (docs/07 §7.3, docs/08 §8.2a).
export const apiTokenApi = {
  list: (): Promise<ListApiTokensResponse> =>
    apiClient.get('/api/me/api-tokens', { schema: listApiTokensResponseSchema }),

  create: (body: CreateApiTokenRequest): Promise<CreateApiTokenResponse> =>
    apiClient.post('/api/me/api-tokens', { schema: createApiTokenResponseSchema, body }),

  revoke: (id: string): Promise<OkResponse> =>
    apiClient.delete(`/api/me/api-tokens/${id}`, { schema: okResponseSchema }),
};

export const apiTokenKeys = {
  all: ['api-tokens'] as const,
};
