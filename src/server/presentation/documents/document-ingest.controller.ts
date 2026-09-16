import { Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { Envelope } from '../../../shared/contracts/common';
import type { UploadDocumentResponse } from '../../../shared/contracts/documents';
import { UploadDocument } from '../../application/documents/upload-document';
import { AppConfig } from '../../infrastructure/config/app-config';
import { successEnvelope } from '../http/envelope';
import { readUploadBody, uploadFileName } from './read-upload-body';
import { CurrentUser } from '../auth/current-user';
import { ApiTokenScopeGuard } from '../auth/api-token-scope.guard';
import type { User } from '../../domain/entities/user';

// POST /api/incoming/documents. The body is the attachment itself, exactly like POST /documents;
// only this route accepts a bearer token with DOCUMENTS_INGEST instead of a browser session.
@Controller('incoming/documents')
export class DocumentIngestController {
  constructor(
    private readonly upload: UploadDocument,
    private readonly config: AppConfig,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(ApiTokenScopeGuard)
  async uploadDocument(
    @Req() req: Request,
    @CurrentUser() user: User,
  ): Promise<Envelope<UploadDocumentResponse>> {
    const bytes = await readUploadBody(req, this.config.get('UPLOAD_MAX_BYTES'));
    return successEnvelope(
      await this.upload.execute(user, { bytes, fileName: uploadFileName(req) }),
    );
  }
}
