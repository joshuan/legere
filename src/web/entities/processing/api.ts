import type { DocumentStep } from '../../../shared/contracts/documents';
import {
  processingCommandResultSchema,
  processingSnapshotSchema,
  updateProcessingPipelineRequestSchema,
  updateProcessingQueueRequestSchema,
  updateProcessingServiceRequestSchema,
  updateProcessingStepRequestSchema,
  type ProcessingCommandResult,
  type ProcessingQueueName,
  type ProcessingSnapshotResponse,
  type UpdateProcessingPipelineRequest,
  type UpdateProcessingQueueRequest,
  type UpdateProcessingServiceRequest,
  type UpdateProcessingStepRequest,
} from '../../../shared/contracts/processing';
import {
  listQueueFailuresResponseSchema,
  reprocessByStepRequestSchema,
  reprocessByStepResponseSchema,
  retryJobResponseSchema,
  servicesHealthResponseSchema,
  type ListQueueFailuresResponse,
  type ReprocessByStepRequest,
  type ReprocessByStepResponse,
  type RetryJobResponse,
  type ServiceName,
  type ServicesHealthResponse,
} from '../../../shared/contracts/queue';
import { apiClient } from '../../shared/api';

const ROOT = '/api/admin/processing';

// The processing control plane is intentionally one read model with narrowly scoped commands.
// Each write carries the revision the operator saw so two open admin tabs cannot overwrite one
// another without the server noticing.
export const processingApi = {
  snapshot: (): Promise<ProcessingSnapshotResponse> =>
    apiClient.get(ROOT, { schema: processingSnapshotSchema }),

  updateQueue: (
    queue: ProcessingQueueName,
    body: UpdateProcessingQueueRequest,
  ): Promise<ProcessingCommandResult> =>
    apiClient.patch(`${ROOT}/queues/${queue}`, {
      schema: processingCommandResultSchema,
      body: updateProcessingQueueRequestSchema.parse(body),
    }),

  updatePipeline: (body: UpdateProcessingPipelineRequest): Promise<ProcessingCommandResult> =>
    apiClient.patch(`${ROOT}/pipeline`, {
      schema: processingCommandResultSchema,
      body: updateProcessingPipelineRequestSchema.parse(body),
    }),

  updateStep: (
    step: DocumentStep,
    body: UpdateProcessingStepRequest,
  ): Promise<ProcessingCommandResult> =>
    apiClient.patch(`${ROOT}/pipeline/steps/${step}`, {
      schema: processingCommandResultSchema,
      body: updateProcessingStepRequestSchema.parse(body),
    }),

  updateService: (
    service: ServiceName,
    body: UpdateProcessingServiceRequest,
  ): Promise<ProcessingCommandResult> =>
    apiClient.patch(`${ROOT}/services/${service}`, {
      schema: processingCommandResultSchema,
      body: updateProcessingServiceRequestSchema.parse(body),
    }),

  checkServices: (): Promise<ServicesHealthResponse> =>
    apiClient.post(`${ROOT}/services/check`, { schema: servicesHealthResponseSchema }),

  failures: (cursor: string | null = null): Promise<ListQueueFailuresResponse> =>
    apiClient.get(
      cursor === null
        ? `${ROOT}/failures`
        : `${ROOT}/failures?cursor=${encodeURIComponent(cursor)}`,
      { schema: listQueueFailuresResponseSchema },
    ),

  retry: (jobId: string): Promise<RetryJobResponse> =>
    apiClient.post(`${ROOT}/failures/${encodeURIComponent(jobId)}/retry`, {
      schema: retryJobResponseSchema,
    }),

  reprocess: (body: ReprocessByStepRequest): Promise<ReprocessByStepResponse> =>
    apiClient.post(`${ROOT}/reprocess`, {
      schema: reprocessByStepResponseSchema,
      body: reprocessByStepRequestSchema.parse(body),
    }),
};

export const processingKeys = {
  snapshot: ['admin', 'processing', 'snapshot'] as const,
  failures: ['admin', 'processing', 'failures'] as const,
};
