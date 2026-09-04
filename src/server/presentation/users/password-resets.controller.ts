import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  credentialPreviewRequestSchema,
  type CredentialPreviewRequest,
  type PasswordResetPreview,
} from '../../../shared/contracts/auth';
import type { Envelope } from '../../../shared/contracts/common';
import { PreviewPasswordReset } from '../../application/users/manage-password-resets';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { ZodBody } from '../http/zod-validation.pipe';

// POST /api/password-resets/preview (docs/07 §7.3) — the token is a JSON value, never a request URL.
@Controller('password-resets')
@Throttled('auth')
export class PasswordResetsController {
  constructor(private readonly previewPasswordReset: PreviewPasswordReset) {}

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  async preview(
    @ZodBody(credentialPreviewRequestSchema) body: CredentialPreviewRequest,
  ): Promise<Envelope<PasswordResetPreview>> {
    return successEnvelope(await this.previewPasswordReset.execute(body.token));
  }
}
