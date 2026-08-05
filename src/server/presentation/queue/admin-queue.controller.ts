import { Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import {
  paginationQuerySchema,
  type Envelope,
  type PaginationQuery,
} from '../../../shared/contracts/common';
import {
  updateQueueSettingsRequestSchema,
  type ListQueueFailuresResponse,
  type QueueOverviewResponse,
  type QueueSettingsDto,
  type RetryJobResponse,
  type UpdateQueueSettingsRequest,
} from '../../../shared/contracts/queue';
import {
  GetQueueOverview,
  ListQueueFailures,
  RetryFailedJob,
} from '../../application/queue/inspect-queue';
import { QueueSettings } from '../../application/queue/queue-settings';
import { WorkerRegistry } from '../../infrastructure/queue/worker-registry';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';
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
    private readonly settings: QueueSettings,
    private readonly workers: WorkerRegistry,
  ) {}

  @Get('settings')
  async getSettings(): Promise<Envelope<QueueSettingsDto>> {
    return successEnvelope(await this.settings.read());
  }

  // Saved, then applied: the workers are re-registered with the new numbers rather than waiting for
  // the container to be bounced (docs/11 §11.13).
  @Patch('settings')
  async updateSettings(
    @ZodBody(updateQueueSettingsRequestSchema) body: UpdateQueueSettingsRequest,
  ): Promise<Envelope<QueueSettingsDto>> {
    const saved = await this.settings.write(body);
    await this.workers.restart();
    return successEnvelope(saved);
  }

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
