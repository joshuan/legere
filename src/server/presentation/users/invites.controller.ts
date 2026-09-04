import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  credentialPreviewRequestSchema,
  type CredentialPreviewRequest,
  type InvitePreview,
} from '../../../shared/contracts/auth';
import type { Envelope } from '../../../shared/contracts/common';
import { PreviewInvite } from '../../application/users/manage-invites';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { ZodBody } from '../http/zod-validation.pipe';

// POST /api/invites/preview (docs/07 §7.3) — the link token stays in JSON rather than entering the
// request URL (SEC-38). Throttled per IP like the auth routes, since it is guessable material.
@Controller('invites')
@Throttled('auth')
export class InvitesController {
  constructor(private readonly previewInvite: PreviewInvite) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @ZodBody(credentialPreviewRequestSchema) body: CredentialPreviewRequest,
  ): Promise<Envelope<InvitePreview>> {
    return successEnvelope(await this.previewInvite.execute(body.token));
  }
}
