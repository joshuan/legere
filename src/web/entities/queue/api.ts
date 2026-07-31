import {
  listQueueFailuresResponseSchema,
  queueOverviewResponseSchema,
  retryJobResponseSchema,
  type ListQueueFailuresResponse,
  type QueueOverviewResponse,
  type RetryJobResponse,
} from '../../../shared/contracts/queue';
import { apiClient } from '../../shared/api';

// Admin queue endpoints (docs/07 §7.3).
export const queueApi = {
  overview: (): Promise<QueueOverviewResponse> =>
    apiClient.get('/api/admin/queue/overview', { schema: queueOverviewResponseSchema }),

  failures: (): Promise<ListQueueFailuresResponse> =>
    apiClient.get('/api/admin/queue/failures', { schema: listQueueFailuresResponseSchema }),

  retry: (jobId: string): Promise<RetryJobResponse> =>
    apiClient.post(`/api/admin/queue/failures/${jobId}/retry`, { schema: retryJobResponseSchema }),
};

export const queueKeys = {
  overview: ['admin', 'queue', 'overview'] as const,
  failures: ['admin', 'queue', 'failures'] as const,
};
