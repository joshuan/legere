import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { InvitePreview } from '../../../shared/contracts/auth';
import type { Envelope } from '../../../shared/contracts/common';
import { PreviewInvite } from '../../application/users/manage-invites';
import { successEnvelope } from '../http/envelope';

// GET /api/invites/:token (docs/07 §7.3) — public landing data for an invite link. Throttled per IP
// like the auth routes, since the token is guessable material (docs/08 §8.4).
@Controller('invites')
@UseGuards(ThrottlerGuard)
export class InvitesController {
  constructor(private readonly previewInvite: PreviewInvite) {}

  @Get(':token')
  async preview(@Param('token') token: string): Promise<Envelope<InvitePreview>> {
    return successEnvelope(await this.previewInvite.execute(token));
  }
}
