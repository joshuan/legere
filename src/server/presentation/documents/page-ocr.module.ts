import { PrepareOcrPage } from '../../application/ocr/prepare-ocr-page';
import { Module } from '@nestjs/common';
import { ManagePageOcr } from '../../application/ocr/manage-page-ocr';
import { HandlePageOcr } from '../../application/ocr/handle-page-ocr';
import { OcrProviders, OcrPageRenderer } from '../../application/ports/page-ocr-provider';
import { FileStorage } from '../../application/ports/file-storage';
import { JobQueue } from '../../application/ports/job-queue';
import { PdfToolbox } from '../../application/ports/pdf-toolbox';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { ServiceGates } from '../../application/queue/service-gate';
import { PageOcrRepository } from '../../domain/repositories/page-ocr.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { GoogleDocumentOcr, YandexVisionOcr } from '../../infrastructure/ocr/cloud-ocr-providers';
import { StirlingOcrRenderer } from '../../infrastructure/ocr/stirling-ocr-renderer';
import { PrismaPageOcrRepository } from '../../infrastructure/persistence/prisma-page-ocr.repository';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { DocumentAccessGuard } from './document-access.guard';
import { PageOcrController } from './page-ocr.controller';

@Module({
  controllers: [PageOcrController],
  providers: [
    ...sessionGuardProviders,
    DocumentAccessGuard,
    { provide: PageOcrRepository, useClass: PrismaPageOcrRepository },
    {
      provide: OcrProviders,
      useFactory: (config: AppConfig, gates: ServiceGates) =>
        new OcrProviders([
          new GoogleDocumentOcr(
            {
              project: config.get('GOOGLE_OCR_PROJECT'),
              location: config.get('GOOGLE_OCR_LOCATION'),
              processor: config.get('GOOGLE_OCR_PROCESSOR'),
              version: config.get('GOOGLE_OCR_VERSION'),
              credentials: config.get('GOOGLE_OCR_CREDENTIALS_JSON'),
            },
            gates,
          ),
          new YandexVisionOcr(config.get('YANDEX_OCR_API_KEY'), gates),
        ]),
      inject: [AppConfig, ServiceGates],
    },
    {
      provide: OcrPageRenderer,
      useFactory: (files: FileStorage, pdfs: PdfToolbox) => new StirlingOcrRenderer(files, pdfs),
      inject: [FileStorage, PdfToolbox],
    },
    {
      provide: PrepareOcrPage,
      useFactory: (repo: PageOcrRepository, renderer: OcrPageRenderer, files: FileStorage) =>
        new PrepareOcrPage(repo, renderer, files),
      inject: [PageOcrRepository, OcrPageRenderer, FileStorage],
    },
    {
      provide: ManagePageOcr,
      useFactory: (
        repo: PageOcrRepository,
        providers: OcrProviders,
        queue: JobQueue,
        tx: UnitOfWork,
        files: FileStorage,
        config: AppConfig,
        images: PrepareOcrPage,
      ) =>
        new ManagePageOcr(
          repo,
          providers,
          queue,
          tx,
          files,
          config.get('SIGNED_URL_TTL_SEC'),
          images,
        ),
      inject: [
        PageOcrRepository,
        OcrProviders,
        JobQueue,
        UnitOfWork,
        FileStorage,
        AppConfig,
        PrepareOcrPage,
      ],
    },
    {
      provide: HandlePageOcr,
      useFactory: (
        repo: PageOcrRepository,
        providers: OcrProviders,
        images: PrepareOcrPage,
        files: FileStorage,
      ) => new HandlePageOcr(repo, providers, images, files),
      inject: [PageOcrRepository, OcrProviders, PrepareOcrPage, FileStorage],
    },
  ],
  exports: [HandlePageOcr, ManagePageOcr],
})
export class PageOcrModule {}
