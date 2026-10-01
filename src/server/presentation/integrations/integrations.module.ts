import { Module } from '@nestjs/common';
import { ManageIntegrations } from '../../application/integrations/manage-integrations';
import { IntegrationDocuments } from '../../application/integrations/integration-documents';
import { UploadDocument } from '../../application/documents/upload-document';
import { IntegrationRepository } from '../../domain/repositories/integration.repository';
import { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { SessionTokens } from '../../application/ports/session-tokens';
import { Clock } from '../../application/ports/clock';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { FileStorage } from '../../application/ports/file-storage';
import { AppConfig } from '../../infrastructure/config/app-config';
import { DocumentsModule } from '../documents/documents.module';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { IntegrationGuard } from './integration.guard';
import { OpenApiController } from './openapi.controller';
import {
  IntegrationDocumentsController,
  MeIntegrationsController,
} from './integrations.controller';

@Module({
  imports: [DocumentsModule],
  controllers: [MeIntegrationsController, IntegrationDocumentsController, OpenApiController],
  providers: [
    ...sessionGuardProviders,
    IntegrationGuard,
    {
      provide: ManageIntegrations,
      useFactory: (
        integrations: IntegrationRepository,
        tokens: ApiTokenRepository,
        secrets: SessionTokens,
        clock: Clock,
        unitOfWork: UnitOfWork,
        config: AppConfig,
      ) =>
        new ManageIntegrations(
          integrations,
          tokens,
          secrets,
          clock,
          unitOfWork,
          config.get('API_TOKEN_TTL_DAYS'),
        ),
      inject: [
        IntegrationRepository,
        ApiTokenRepository,
        SessionTokens,
        Clock,
        UnitOfWork,
        AppConfig,
      ],
    },
    {
      provide: IntegrationDocuments,
      useFactory: (
        documents: DocumentRepository,
        upload: UploadDocument,
        storage: FileStorage,
        clock: Clock,
        config: AppConfig,
      ) =>
        new IntegrationDocuments(
          documents,
          upload,
          storage,
          clock,
          config.get('APP_BASE_URL'),
          config.get('SIGNED_URL_TTL_SEC'),
        ),
      inject: [DocumentRepository, UploadDocument, FileStorage, Clock, AppConfig],
    },
  ],
})
export class IntegrationsModule {}
