import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { PasswordResetPreview } from '../../../shared/contracts/auth';
import type { Envelope } from '../../../shared/contracts/common';
import { PreviewPasswordReset } from '../../application/users/manage-password-resets';
import { successEnvelope } from '../http/envelope';

// GET /api/password-resets/:token (docs/07 §7.3) — public landing data for a reset link.
@Controller('password-resets')
@UseGuards(ThrottlerGuard)
export class PasswordResetsController {
  constructor(private readonly previewPasswordReset: PreviewPasswordReset) {}

  @Get(':token')
  async preview(@Param('token') token: string): Promise<Envelope<PasswordResetPreview>> {
    return successEnvelope(await this.previewPasswordReset.execute(token));
  }
}
