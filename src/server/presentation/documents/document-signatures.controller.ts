import { Controller, Delete, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MAX_SIGNATURE_BYTES } from '../../../shared/contracts/signatures';
import { ManageSignatures } from '../../application/documents/manage-signatures';
import type { User } from '../../domain/entities/user';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { UuidParam } from '../http/uuid-param.pipe';
import { CurrentDocument, DocumentAccessGuard } from './document-access.guard';
import { attachedFileName, readUploadBody } from './read-upload-body';

@Controller('documents/:id')
@UseGuards(SessionGuard, RolesGuard, DocumentAccessGuard)
export class DocumentSignaturesController {
  constructor(
    private readonly signatures: ManageSignatures,
    private readonly config: AppConfig,
  ) {}

  @Get('signatures')
  async list(
    @CurrentDocument() detail: DocumentDetail,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    return successEnvelope(await this.signatures.list(detail));
  }

  @Post('files/:fileId/signatures')
  async attach(
    @CurrentUser() viewer: User,
    @CurrentDocument() detail: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @Req() request: Request,
  ) {
    const name = attachedFileName(request);
    const bytes = await readUploadBody(
      request,
      Math.min(MAX_SIGNATURE_BYTES, this.config.get('UPLOAD_MAX_BYTES')),
    );
    return successEnvelope(await this.signatures.attach(viewer, detail, fileId, name, bytes));
  }

  @Get('files/:fileId/signatures/:signatureId/content')
  async content(
    @CurrentDocument() detail: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @UuidParam('signatureId', 'FILE_NOT_FOUND', 'Signature') signatureId: string,
    @Res() response: Response,
  ) {
    response.setHeader('Cache-Control', 'private, no-store');
    response.redirect(302, await this.signatures.download(detail, fileId, signatureId));
  }

  @Delete('files/:fileId/signatures/:signatureId')
  @Roles('ADMIN')
  async remove(
    @CurrentDocument() detail: DocumentDetail,
    @UuidParam('fileId', 'FILE_NOT_FOUND', 'File') fileId: string,
    @UuidParam('signatureId', 'FILE_NOT_FOUND', 'Signature') signatureId: string,
  ) {
    return successEnvelope(await this.signatures.remove(detail, fileId, signatureId));
  }
}
