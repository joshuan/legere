import { ReceiptReviewRepository } from '../../domain/repositories/receipt-review.repository';
import { PdfToolbox } from '../../application/ports/pdf-toolbox';
import {
  ReadReceiptDuplicates,
  ResolveReceiptDuplicates,
} from '../../application/receipts/review-receipt-duplicates';
import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { RECEIPT_SOURCE_TEXT_MAX_CHARS } from '../../../shared/contracts/receipts';
import {
  DeleteReceipt,
  GetReceipt,
  GetReceiptArtifactUrl,
  ListReceipts,
} from '../../application/receipts/manage-receipts';
import { UploadReceipt } from '../../application/receipts/upload-receipt';
import { Clock } from '../../application/ports/clock';
import { FileStorage } from '../../application/ports/file-storage';
import { JobQueue } from '../../application/ports/job-queue';
import { MimeDetector } from '../../application/ports/mime-detector';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { FileRepository } from '../../domain/repositories/file.repository';
import { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { ReceiptsController } from './receipts.controller';
import { ReceiptIngestController } from './receipt-ingest.controller';
import { ApiTokenScopeGuard } from '../auth/api-token-scope.guard';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        limits: {
          files: 1,
          fields: 1,
          fileSize: config.get('UPLOAD_MAX_BYTES'),
          fieldSize: RECEIPT_SOURCE_TEXT_MAX_CHARS * 4,
        },
      }),
    }),
  ],
  controllers: [ReceiptsController, ReceiptIngestController],
  providers: [
    ...sessionGuardProviders,
    ApiTokenScopeGuard,
    {
      provide: ReadReceiptDuplicates,
      inject: [ReceiptRepository, ReceiptReviewRepository, FileStorage, AppConfig],
      useFactory: (
        receipts: ReceiptRepository,
        reviews: ReceiptReviewRepository,
        storage: FileStorage,
        config: AppConfig,
      ) => new ReadReceiptDuplicates(receipts, reviews, storage, config.get('SIGNED_URL_TTL_SEC')),
    },
    {
      provide: ResolveReceiptDuplicates,
      inject: [
        ReceiptRepository,
        ReceiptReviewRepository,
        FileRepository,
        FileStorage,
        PdfToolbox,
        JobQueue,
        DocumentEventRepository,
        UnitOfWork,
        Clock,
        AppConfig,
      ],
      useFactory: (
        receipts: ReceiptRepository,
        reviews: ReceiptReviewRepository,
        files: FileRepository,
        storage: FileStorage,
        pdfs: PdfToolbox,
        queue: JobQueue,
        events: DocumentEventRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
        config: AppConfig,
      ) =>
        new ResolveReceiptDuplicates(
          receipts,
          reviews,
          files,
          storage,
          pdfs,
          queue,
          events,
          unitOfWork,
          clock,
          config.get('UPLOAD_MAX_BYTES'),
        ),
    },
    {
      provide: ListReceipts,
      useFactory: (receipts: ReceiptRepository): ListReceipts => new ListReceipts(receipts),
      inject: [ReceiptRepository],
    },
    {
      provide: GetReceipt,
      useFactory: (receipts: ReceiptRepository, reviews: ReceiptReviewRepository): GetReceipt =>
        new GetReceipt(receipts, reviews),
      inject: [ReceiptRepository, ReceiptReviewRepository],
    },
    {
      provide: UploadReceipt,
      useFactory: (
        receipts: ReceiptRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        storage: FileStorage,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): UploadReceipt =>
        new UploadReceipt(receipts, files, events, storage, mime, queue, unitOfWork),
      inject: [
        ReceiptRepository,
        FileRepository,
        DocumentEventRepository,
        FileStorage,
        MimeDetector,
        JobQueue,
        UnitOfWork,
      ],
    },
    {
      provide: DeleteReceipt,
      useFactory: (
        receipts: ReceiptRepository,
        files: FileRepository,
        storage: FileStorage,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): DeleteReceipt => new DeleteReceipt(receipts, files, storage, unitOfWork, clock),
      inject: [ReceiptRepository, FileRepository, FileStorage, UnitOfWork, Clock],
    },
    {
      provide: GetReceiptArtifactUrl,
      useFactory: (
        receipts: ReceiptRepository,
        storage: FileStorage,
        config: AppConfig,
      ): GetReceiptArtifactUrl =>
        new GetReceiptArtifactUrl(receipts, storage, config.get('SIGNED_URL_TTL_SEC')),
      inject: [ReceiptRepository, FileStorage, AppConfig],
    },
  ],
})
export class ReceiptsModule {}
