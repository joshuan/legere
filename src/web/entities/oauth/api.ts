import {
  oauthConsentPreviewSchema,
  oauthConsentResultSchema,
  oauthGrantListSchema,
  type OAuthAuthorization,
} from '../../../shared/contracts/oauth';
import { okResponseSchema } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

export const oauthKeys = { grants: ['oauth-grants'] as const };
export const oauthApi = {
  preview: (query: OAuthAuthorization) =>
    apiClient.get('/api/oauth/authorize/preview', { schema: oauthConsentPreviewSchema, query }),
  authorize: (body: OAuthAuthorization & { decision: 'approve' | 'deny' }) =>
    apiClient.post('/api/oauth/authorize', { schema: oauthConsentResultSchema, body }),
  list: () => apiClient.get('/api/me/oauth-grants', { schema: oauthGrantListSchema }),
  revoke: (id: string) =>
    apiClient.delete(`/api/me/oauth-grants/${id}`, { schema: okResponseSchema }),
};
