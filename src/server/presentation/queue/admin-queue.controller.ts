import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  paginationQuerySchema,
  type Envelope,
  type PaginationQuery,
} from '../../../shared/contracts/common';
import type {
  ListQueueFailuresResponse,
  QueueOverviewResponse,
  RetryJobResponse,
} from '../../../shared/contracts/queue';
import {
  GetQueueOverview,
  ListQueueFailures,
  RetryFailedJob,
} from '../../application/queue/inspect-queue';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodQuery } from '../http/zod-validation.pipe';
import { UuidParam } from '../http/uuid-param.pipe';

// Admin queue observability (docs/07 §7.3, docs/05 §5.8, docs/11 §11.13).
@Controller('admin/queue')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminQueueController {
  constructor(
    private readonly overview: GetQueueOverview,
    private readonly failures: ListQueueFailures,
    private readonly retryJob: RetryFailedJob,
  ) {}

  @Get('overview')
  async getOverview(): Promise<Envelope<QueueOverviewResponse>> {
    return successEnvelope(await this.overview.execute());
  }

  @Get('failures')
  async listFailures(
    @ZodQuery(paginationQuerySchema) query: PaginationQuery,
  ): Promise<Envelope<ListQueueFailuresResponse>> {
    return successEnvelope(await this.failures.execute(query));
  }

  @Post('failures/:jobId/retry')
  async retry(
    @UuidParam('jobId', 'NOT_FOUND', 'Job') jobId: string,
  ): Promise<Envelope<RetryJobResponse>> {
    return successEnvelope(await this.retryJob.execute(jobId));
  }
}
