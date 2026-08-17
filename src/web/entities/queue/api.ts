import {
  listQueueFailuresResponseSchema,
  pausedStepsResponseSchema,
  queueOverviewResponseSchema,
  queueSettingsSchema,
  reprocessByStepRequestSchema,
  reprocessByStepResponseSchema,
  retryJobResponseSchema,
  servicesHealthResponseSchema,
  updateQueueSettingsRequestSchema,
  type ListQueueFailuresResponse,
  type PausedStepsResponse,
  type QueueOverviewResponse,
  type QueueSettingsDto,
  type ReprocessByStepRequest,
  type ReprocessByStepResponse,
  type RetryJobResponse,
  type ServicesHealthResponse,
  type UpdateQueueSettingsRequest,
} from '../../../shared/contracts/queue';
import {
  analysisLanguageSchema,
  updateAnalysisLanguageRequestSchema,
  type AnalysisLanguageDto,
  type UpdateAnalysisLanguageRequest,
} from '../../../shared/contracts/settings';
import { apiClient } from '../../shared/api';

// Admin queue endpoints (docs/07 §7.3).
export const queueApi = {
  overview: (): Promise<QueueOverviewResponse> =>
    apiClient.get('/api/admin/queue/overview', { schema: queueOverviewResponseSchema }),

  failures: (): Promise<ListQueueFailuresResponse> =>
    apiClient.get('/api/admin/queue/failures', { schema: listQueueFailuresResponseSchema }),

  retry: (jobId: string): Promise<RetryJobResponse> =>
    apiClient.post(`/api/admin/queue/failures/${jobId}/retry`, { schema: retryJobResponseSchema }),

  // "The previews failed, run them again" — every document whose named step sits in that status,
  // in one gesture instead of five hundred (docs/11 §11.13).
  reprocess: (body: ReprocessByStepRequest): Promise<ReprocessByStepResponse> =>
    apiClient.post('/api/admin/queue/reprocess', {
      schema: reprocessByStepResponseSchema,
      body: reprocessByStepRequestSchema.parse(body),
    }),
};

export const queueSettingsApi = {
  read: (): Promise<QueueSettingsDto> =>
    apiClient.get('/api/admin/queue/settings', { schema: queueSettingsSchema }),

  save: (body: UpdateQueueSettingsRequest): Promise<QueueSettingsDto> =>
    apiClient.patch('/api/admin/queue/settings', {
      schema: queueSettingsSchema,
      body: updateQueueSettingsRequestSchema.parse(body),
    }),
};

// What the analysis writes in (docs/05 §5.5).
export const analysisSettingsApi = {
  read: (): Promise<AnalysisLanguageDto> =>
    apiClient.get('/api/admin/queue/analysis', { schema: analysisLanguageSchema }),

  save: (body: UpdateAnalysisLanguageRequest): Promise<AnalysisLanguageDto> =>
    apiClient.patch('/api/admin/queue/analysis', {
      schema: analysisLanguageSchema,
      body: updateAnalysisLanguageRequestSchema.parse(body),
    }),
};

// Where each external service is and whether it answers (docs/05 §5.4c). Read on its own rather
// than with the settings: a probe leaves the instance and can be slow, and the gates beside it must
// draw and save while it is still out (docs/11 §11.13).
export const servicesHealthApi = {
  read: (): Promise<ServicesHealthResponse> =>
    apiClient.get('/api/admin/queue/services', { schema: servicesHealthResponseSchema }),
};

// Which steps the pipeline is holding (docs/05 §5.4d). The one queue fact that is not an admin's:
// a step reading PENDING for ever is either waiting for a worker or paused, and the document's own
// page has to be able to say which (docs/11 §11.5).
export const pipelineApi = {
  pausedSteps: (): Promise<PausedStepsResponse> =>
    apiClient.get('/api/pipeline/paused-steps', { schema: pausedStepsResponseSchema }),
};

export const queueKeys = {
  settings: ['queue', 'settings'] as const,
  pausedSteps: ['pipeline', 'paused-steps'] as const,
  analysis: ['queue', 'analysis'] as const,
  overview: ['admin', 'queue', 'overview'] as const,
  failures: ['admin', 'queue', 'failures'] as const,
  services: ['admin', 'queue', 'services'] as const,
};
