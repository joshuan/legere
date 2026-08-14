import { Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { type Envelope } from '../../../shared/contracts/common';
import {
  listQueueFailuresQuerySchema,
  reprocessByStepRequestSchema,
  updateQueueSettingsRequestSchema,
  type ListQueueFailuresQuery,
  type ListQueueFailuresResponse,
  type QueueOverviewResponse,
  type QueueSettingsDto,
  type ReprocessByStepRequest,
  type ReprocessByStepResponse,
  type RetryJobResponse,
  type UpdateQueueSettingsRequest,
} from '../../../shared/contracts/queue';
import type { User } from '../../domain/entities/user';
import {
  GetQueueOverview,
  ListQueueFailures,
  RetryFailedJob,
} from '../../application/queue/inspect-queue';
import { QueueSettings } from '../../application/queue/queue-settings';
import { ServiceGates } from '../../application/queue/service-gate';
import { ReprocessDocumentsByStep } from '../../application/queue/reprocess-by-step';
import { AnalysisSettings } from '../../application/settings/analysis-settings';
import { WorkerRegistry } from '../../infrastructure/queue/worker-registry';
import {
  updateAnalysisLanguageRequestSchema,
  type AnalysisLanguageDto,
  type UpdateAnalysisLanguageRequest,
} from '../../../shared/contracts/settings';
import { CurrentUser } from '../auth/current-user';
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
    private readonly analysis: AnalysisSettings,
    private readonly reprocessByStep: ReprocessDocumentsByStep,
    private readonly gates: ServiceGates,
  ) {}

  @Get('settings')
  async getSettings(): Promise<Envelope<QueueSettingsDto>> {
    return successEnvelope(await this.settings.read());
  }

  // What the analysis writes in (docs/05 §5.5). It lives beside the queue knobs because it is the
  // same kind of thing — how this instance does its work — and an admin settings screen of its own
  // for one field would be a screen nobody visits.
  @Get('analysis')
  async getAnalysis(): Promise<Envelope<AnalysisLanguageDto>> {
    return successEnvelope(await this.analysis.read());
  }

  @Patch('analysis')
  async updateAnalysis(
    @ZodBody(updateAnalysisLanguageRequestSchema) body: UpdateAnalysisLanguageRequest,
  ): Promise<Envelope<AnalysisLanguageDto>> {
    // Read per document rather than at start-up, so nothing needs re-registering here.
    return successEnvelope(await this.analysis.write(body));
  }

  // Saved, then applied: the workers are re-registered with the new numbers rather than waiting for
  // the container to be bounced (docs/11 §11.13). Pausing and resuming ride the same path — a queue
  // that is now paused gets no worker back, and one that is not does.
  @Patch('settings')
  async updateSettings(
    @ZodBody(updateQueueSettingsRequestSchema) body: UpdateQueueSettingsRequest,
  ): Promise<Envelope<QueueSettingsDto>> {
    const saved = await this.settings.write(body);
    // The gates first, and in their own right: a widened gate releases the callers standing at it
    // straight away, and it must do so even if re-registering the workers goes wrong (docs/05
    // §5.4b). Starting the workers configures them again from the same row, which costs nothing.
    this.gates.configure(saved.services);
    await this.workers.restart();
    return successEnvelope(saved);
  }

  // "The previews failed, run them again" (docs/07 §7.3, docs/11 §11.13): every document whose named
  // step sits in that status goes back through the ordinary reprocess, newest first and bounded per
  // call, and the answer says how many this call took.
  @Post('reprocess')
  async reprocessStep(
    @CurrentUser() user: User,
    @ZodBody(reprocessByStepRequestSchema) body: ReprocessByStepRequest,
  ): Promise<Envelope<ReprocessByStepResponse>> {
    return successEnvelope(await this.reprocessByStep.execute(body, user.id));
  }

  @Get('overview')
  async getOverview(): Promise<Envelope<QueueOverviewResponse>> {
    return successEnvelope(await this.overview.execute());
  }

  // 🔒 The cursor is the `failedAt` of the last row, and is validated as one: an unreadable cursor
  // is a malformed query parameter here, not an opaque string to start over from (docs/07 §7.1).
  @Get('failures')
  async listFailures(
    @ZodQuery(listQueueFailuresQuerySchema) query: ListQueueFailuresQuery,
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
