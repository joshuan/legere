import { Controller, Get, UseGuards } from '@nestjs/common';
import { type Envelope } from '../../../shared/contracts/common';
import { type PausedStepsResponse } from '../../../shared/contracts/queue';
import { QueueSettings } from '../../application/queue/queue-settings';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';

// GET /api/pipeline/paused-steps (docs/07 §7.3, docs/05 §5.4d). The one fact about the queue that
// belongs to every reader rather than to an admin: a step held at `PENDING` looks exactly like a step
// waiting for a worker, and the difference is the answer to "why has this document been half
// processed for two days" (docs/11 §11.5).
//
// 🔒 Nothing else about the queue is published here — no depths, no concurrencies, no gates, no
// addresses. A paused step is not a secret: it is visible on every document it holds.
@Controller('pipeline')
@UseGuards(SessionGuard)
export class PipelineController {
  constructor(private readonly settings: QueueSettings) {}

  @Get('paused-steps')
  async pausedSteps(): Promise<Envelope<PausedStepsResponse>> {
    return successEnvelope({ pausedSteps: [...(await this.settings.heldSteps())] });
  }
}
