import {
  integrationSchema,
  listIntegrationsSchema,
  integrationTokenResponseSchema,
} from '../../../shared/contracts/integrations';
import { okResponseSchema } from '../../../shared/contracts/users';
import { apiClient } from '../../shared/api';

export const integrationKeys = { all: ['integrations'] as const };
export const integrationApi = {
  list: () => apiClient.get('/api/me/integrations', { schema: listIntegrationsSchema }),
  create: (name: string) =>
    apiClient.post('/api/me/integrations', { schema: integrationSchema, body: { name } }),
  issue: (id: string, body: { name: string; expiresInDays?: number }) =>
    apiClient.post(`/api/me/integrations/${id}/tokens`, {
      schema: integrationTokenResponseSchema,
      body,
    }),
  revoke: (id: string) =>
    apiClient.delete(`/api/me/integrations/${id}`, { schema: okResponseSchema }),
};
