import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import type { Envelope } from '../../../shared/contracts/common';
import {
  reprocessRequestSchema,
  type ReprocessRequest,
  type ReprocessResponse,
} from '../../../shared/contracts/documents';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';

// Documents (docs/07 §7.3). The read model arrives with M5; reprocessing is here because it is the
// operator's half of the pipeline.
@Controller('documents')
@UseGuards(SessionGuard, RolesGuard)
export class DocumentsController {
  constructor(private readonly reprocess: ReprocessDocument) {}

  // Admin only: reprocessing costs OCR and provider calls, and it rewrites artifacts.
  @Post(':id/reprocess')
  @Roles('ADMIN')
  async reprocessDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(reprocessRequestSchema) body: ReprocessRequest,
  ): Promise<Envelope<ReprocessResponse>> {
    return successEnvelope(await this.reprocess.execute(id, body.steps));
  }
}
