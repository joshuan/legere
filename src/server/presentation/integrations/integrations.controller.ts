import { Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import {
  createIntegrationSchema,
  integrationTokenRequestSchema,
  integrationDocumentsQuerySchema,
} from '../../../shared/contracts/integrations';
import { ManageIntegrations } from '../../application/integrations/manage-integrations';
import { IntegrationDocuments } from '../../application/integrations/integration-documents';
import type { Viewer } from '../../domain/repositories/document.repository';
import type { User } from '../../domain/entities/user';
import { AppConfig } from '../../infrastructure/config/app-config';
import { CurrentActor, CurrentUser, CurrentSession } from '../auth/current-user';
import type { Session } from '../../domain/entities/session';
import { SessionGuard } from '../auth/session.guard';
import { UuidParam } from '../http/uuid-param.pipe';
import { ZodBody, ZodQuery } from '../http/zod-validation.pipe';
import { successEnvelope } from '../http/envelope';
import { Throttled } from '../http/throttling';
import { readUploadBody, uploadFileName } from '../documents/read-upload-body';
import { IntegrationGuard } from './integration.guard';

@Controller('me/integrations')
@UseGuards(SessionGuard)
export class MeIntegrationsController {
  constructor(private readonly integrations: ManageIntegrations) {}
  @Get()
  async list(@CurrentUser() user: User, @CurrentSession() _session: Session) {
    return successEnvelope(await this.integrations.list(user.id));
  }
  @Post()
  @Throttled('catalogue')
  async create(
    @CurrentUser() user: User,
    @ZodBody(createIntegrationSchema) body: z.infer<typeof createIntegrationSchema>,
  ) {
    return successEnvelope(await this.integrations.create(user.id, body.name));
  }
  @Post(':id/tokens')
  @Throttled('catalogue')
  async issue(
    @CurrentUser() user: User,
    @UuidParam('id', 'NOT_FOUND', 'Integration') id: string,
    @ZodBody(integrationTokenRequestSchema) body: z.infer<typeof integrationTokenRequestSchema>,
  ) {
    return successEnvelope(await this.integrations.issue(user.id, id, body));
  }
  @Delete(':id')
  async revoke(@CurrentUser() user: User, @UuidParam('id', 'NOT_FOUND', 'Integration') id: string) {
    await this.integrations.revoke(user.id, id);
    return successEnvelope({ ok: true });
  }
}

@Controller('integrations/documents')
@UseGuards(IntegrationGuard)
export class IntegrationDocumentsController {
  constructor(
    private readonly documents: IntegrationDocuments,
    private readonly config: AppConfig,
  ) {}
  @Post()
  @HttpCode(201)
  @Throttled('catalogue')
  async create(@CurrentActor() viewer: Viewer, @Req() request: Request) {
    const bytes = await readUploadBody(request, this.config.get('UPLOAD_MAX_BYTES'));
    return successEnvelope(
      await this.documents.create(viewer, { bytes, fileName: uploadFileName(request) }),
    );
  }
  @Get()
  async list(
    @CurrentActor() viewer: Viewer,
    @ZodQuery(integrationDocumentsQuerySchema)
    query: z.infer<typeof integrationDocumentsQuerySchema>,
  ) {
    return successEnvelope(await this.documents.list(viewer, query));
  }
  @Get(':id')
  async get(
    @CurrentActor() viewer: Viewer,
    @UuidParam('id', 'DOCUMENT_NOT_FOUND', 'Document') id: string,
  ) {
    return successEnvelope(await this.documents.get(viewer, id));
  }
  @Get(':id/canonical')
  async canonical(
    @CurrentActor() viewer: Viewer,
    @UuidParam('id', 'DOCUMENT_NOT_FOUND', 'Document') id: string,
  ) {
    return successEnvelope(await this.documents.artifact(viewer, id, 'canonical'));
  }
  @Get(':id/preview')
  async preview(
    @CurrentActor() viewer: Viewer,
    @UuidParam('id', 'DOCUMENT_NOT_FOUND', 'Document') id: string,
  ) {
    return successEnvelope(await this.documents.artifact(viewer, id, 'preview'));
  }
}
