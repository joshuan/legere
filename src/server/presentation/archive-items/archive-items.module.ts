import { Module } from '@nestjs/common';
import { ConvertArchiveItem } from '../../application/archive-items/convert-archive-item';
import { FileStorage } from '../../application/ports/file-storage';
import { JobQueue } from '../../application/ports/job-queue';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { ArchiveItemRepository } from '../../domain/repositories/archive-item.repository';
import { CollectionRepository } from '../../domain/repositories/collection.repository';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { FileRepository } from '../../domain/repositories/file.repository';
import { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { ArchiveItemsController } from './archive-items.controller';

@Module({
  controllers: [ArchiveItemsController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: ConvertArchiveItem,
      useFactory: (
        archiveItems: ArchiveItemRepository,
        documents: DocumentRepository,
        receipts: ReceiptRepository,
        files: FileRepository,
        collections: CollectionRepository,
        events: DocumentEventRepository,
        storage: FileStorage,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): ConvertArchiveItem =>
        new ConvertArchiveItem(
          archiveItems,
          documents,
          receipts,
          files,
          collections,
          events,
          storage,
          queue,
          unitOfWork,
        ),
      inject: [
        ArchiveItemRepository,
        DocumentRepository,
        ReceiptRepository,
        FileRepository,
        CollectionRepository,
        DocumentEventRepository,
        FileStorage,
        JobQueue,
        UnitOfWork,
      ],
    },
  ],
})
export class ArchiveItemsModule {}
