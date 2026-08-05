import { instanceResponseSchema, type InstanceResponse } from '../../../shared/contracts/instance';
import { apiClient } from '../../shared/api';

// What this server resolved its configuration to (docs/07 §7.3). Read-only: there is nothing here
// to submit — a setting is changed in the environment and the process restarted.
export const instanceApi = {
  read: (): Promise<InstanceResponse> =>
    apiClient.get('/api/admin/instance', { schema: instanceResponseSchema }),
};

export const instanceKeys = {
  effective: ['admin', 'instance'] as const,
};
