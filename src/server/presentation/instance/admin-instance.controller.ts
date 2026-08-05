import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import type { InstanceResponse } from '../../../shared/contracts/instance';
import { AppConfig } from '../../infrastructure/config/app-config';
import { describeInstance } from '../../infrastructure/config/instance-view';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';

// What this server is actually running (docs/07 §7.3, docs/11 §11.13a). Read-only, and admin-only:
// the shape of a deployment — its database, its bucket, its providers — is not everybody's business
// even when no secret is in it.
@Controller('admin/instance')
@UseGuards(SessionGuard, RolesGuard)
@Roles('ADMIN')
export class AdminInstanceController {
  constructor(private readonly config: AppConfig) {}

  @Get()
  read(): Envelope<InstanceResponse> {
    // Resolved per request rather than cached: it costs nothing, and a cached answer would be one
    // more thing that can disagree with the process it describes.
    return successEnvelope(describeInstance(this.config));
  }
}
