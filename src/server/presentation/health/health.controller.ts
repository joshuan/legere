import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CheckHealth } from '../../application/health/check-health';
import { successEnvelope } from '../http/envelope';

// GET /api/health (docs/07 §7.3, docs/06 §6.10): 200 when healthy, 503 when a component is down.
// Not authenticated, not rate-limited; used as the container liveness/readiness probe.
@Controller('health')
export class HealthController {
  constructor(private readonly checkHealth: CheckHealth) {}

  @Get()
  async get(@Res() res: Response): Promise<void> {
    const data = await this.checkHealth.execute();
    const status = data.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(status).json(successEnvelope(data));
  }
}
