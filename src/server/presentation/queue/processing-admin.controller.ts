import { Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { type Envelope } from '../../../shared/contracts/common';
import { documentStepSchema, type DocumentStep } from '../../../shared/contracts/documents';
import {
  processingQueueNameSchema,
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
  listQueueFailuresQuerySchema,
  reprocessByStepRequestSchema,
  SERVICE_NAMES,
  type ListQueueFailuresQuery,
  type ListQueueFailuresResponse,
  type ReprocessByStepRequest,
  type ReprocessByStepResponse,
  type RetryJobResponse,
  type ServiceName,
  type ServicesHealthResponse,
} from '../../../shared/contracts/queue';
import { ProcessingControlPlane } from '../../application/processing/processing-control-plane';
import type { User } from '../../domain/entities/user';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody, ZodParam, ZodQuery } from '../http/zod-validation.pipe';
import { z } from 'zod';

const serviceNameSchema = z.enum(SERVICE_NAMES);

@Controller('admin/processing')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class ProcessingAdminController {
  constructor(private readonly controlPlane: ProcessingControlPlane) {}

  @Get()
  async snapshot(): Promise<Envelope<ProcessingSnapshotResponse>> {
    return successEnvelope(await this.controlPlane.snapshot());
  }

  @Patch('queues/:queue')
  async updateQueue(
    @CurrentUser() user: User,
    @ZodParam('queue', processingQueueNameSchema) queue: ProcessingQueueName,
    @ZodBody(updateProcessingQueueRequestSchema) body: UpdateProcessingQueueRequest,
  ): Promise<Envelope<ProcessingCommandResult>> {
    return successEnvelope(
      await this.controlPlane.update({ kind: 'queue', queue, ...body }, user.id),
    );
  }

  @Patch('pipeline')
  async updatePipeline(
    @CurrentUser() user: User,
    @ZodBody(updateProcessingPipelineRequestSchema) body: UpdateProcessingPipelineRequest,
  ): Promise<Envelope<ProcessingCommandResult>> {
    return successEnvelope(await this.controlPlane.update({ kind: 'pipeline', ...body }, user.id));
  }

  @Patch('pipeline/steps/:step')
  async updateStep(
    @CurrentUser() user: User,
    @ZodParam('step', documentStepSchema) step: DocumentStep,
    @ZodBody(updateProcessingStepRequestSchema) body: UpdateProcessingStepRequest,
  ): Promise<Envelope<ProcessingCommandResult>> {
    return successEnvelope(
      await this.controlPlane.update({ kind: 'step', step, ...body }, user.id),
    );
  }

  @Patch('services/:service')
  async updateService(
    @CurrentUser() user: User,
    @ZodParam('service', serviceNameSchema) service: ServiceName,
    @ZodBody(updateProcessingServiceRequestSchema) body: UpdateProcessingServiceRequest,
  ): Promise<Envelope<ProcessingCommandResult>> {
    return successEnvelope(
      await this.controlPlane.update({ kind: 'service', service, ...body }, user.id),
    );
  }

  @Post('services/check')
  async checkServices(): Promise<Envelope<ServicesHealthResponse>> {
    return successEnvelope(await this.controlPlane.checkServices());
  }

  @Get('failures')
  async failures(
    @ZodQuery(listQueueFailuresQuerySchema) query: ListQueueFailuresQuery,
  ): Promise<Envelope<ListQueueFailuresResponse>> {
    return successEnvelope(await this.controlPlane.listFailures(query));
  }

  @Post('failures/:jobId/retry')
  async retry(
    @UuidParam('jobId', 'NOT_FOUND', 'Job') jobId: string,
  ): Promise<Envelope<RetryJobResponse>> {
    return successEnvelope(await this.controlPlane.retry(jobId));
  }

  @Post('reprocess')
  async reprocess(
    @CurrentUser() user: User,
    @ZodBody(reprocessByStepRequestSchema) body: ReprocessByStepRequest,
  ): Promise<Envelope<ReprocessByStepResponse>> {
    return successEnvelope(await this.controlPlane.reprocess(body, user.id));
  }
}
