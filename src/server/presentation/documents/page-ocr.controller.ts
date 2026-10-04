import { Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { startOcrSchema, type StartOcrInput } from '../../../shared/contracts/page-ocr';
import { ManagePageOcr } from '../../application/ocr/manage-page-ocr';
import type { User } from '../../domain/entities/user';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentDetail } from '../../domain/repositories/document.repository';
import { CurrentUser } from '../auth/current-user';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { SessionGuard } from '../auth/session.guard';
import { successEnvelope } from '../http/envelope';
import { ZodBody } from '../http/zod-validation.pipe';
import { CurrentDocument, DocumentAccessGuard } from './document-access.guard';

function uuid(value: string): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new NotFoundError('DOCUMENT_NOT_FOUND');
  return parsed.data;
}

@Controller('documents/:id')
@UseGuards(SessionGuard, RolesGuard, DocumentAccessGuard)
export class PageOcrController {
  constructor(private readonly ocr: ManagePageOcr) {}
  @Get('ocr-runs')
  async list(@CurrentDocument() detail: DocumentDetail) {
    return successEnvelope(await this.ocr.list(detail.document));
  }
  @Post('ocr-runs')
  @Roles('ADMIN')
  async start(
    @CurrentUser() user: User,
    @CurrentDocument() detail: DocumentDetail,
    @ZodBody(startOcrSchema) body: StartOcrInput,
  ) {
    return successEnvelope(await this.ocr.start(user, detail.document, body));
  }
  @Get('ocr-runs/:runId')
  async get(@CurrentDocument() detail: DocumentDetail, @Param('runId') runId: string) {
    return successEnvelope(await this.ocr.get(detail.document, uuid(runId)));
  }
  @Post('ocr-runs/:runId/retry')
  @Roles('ADMIN')
  async retry(
    @CurrentUser() user: User,
    @CurrentDocument() detail: DocumentDetail,
    @Param('runId') runId: string,
  ) {
    return successEnvelope(await this.ocr.retry(user, detail.document, uuid(runId)));
  }
  @Get('ocr-pages/:pageId/image')
  async pageImage(
    @CurrentDocument() detail: DocumentDetail,
    @Param('pageId') pageId: string,
    @Res() response: Response,
  ) {
    const url = await this.ocr.pageImage(detail.document, uuid(pageId));
    response.setHeader('Cache-Control', 'private, no-store');
    response.redirect(302, url);
  }
  @Get('ocr-results/:resultId')
  async result(@CurrentDocument() detail: DocumentDetail, @Param('resultId') resultId: string) {
    return successEnvelope(await this.ocr.result(detail.document, uuid(resultId)));
  }
  @Get('ocr-results/:resultId/:kind')
  async artifact(
    @CurrentDocument() detail: DocumentDetail,
    @Param('resultId') resultId: string,
    @Param('kind') kind: string,
    @Res() response: Response,
  ) {
    if (kind !== 'image' && kind !== 'raw' && kind !== 'json')
      throw new NotFoundError('DOCUMENT_NOT_FOUND');
    const url = await this.ocr.artifact(detail.document, uuid(resultId), kind);
    response.setHeader('Cache-Control', 'private, no-store');
    response.redirect(302, url);
  }
}
