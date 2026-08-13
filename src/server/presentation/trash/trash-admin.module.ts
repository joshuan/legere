import { Module } from '@nestjs/common';
import { JobQueue } from '../../application/ports/job-queue';
import { FileStorage } from '../../application/ports/file-storage';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentFileBytes } from '../../application/documents/document-file-bytes';
import { LibraryReader } from '../../application/ports/library-reader';
import { Clock } from '../../application/ports/clock';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import {
  DeleteTrashItem,
  DownloadTrashItem,
  EmptyTrash,
  ListTrash,
  RestoreTrashItem,
} from '../../application/trash/manage-trash';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { FileRepository } from '../../domain/repositories/file.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminTrashController } from './admin-trash.controller';

// The trash (docs/06 §6.5, docs/05 §5.7a).
@Module({
  controllers: [AdminTrashController],
  providers: [
    ...sessionGuardProviders,
    {
      provide: ListTrash,
      useFactory: (files: FileRepository, config: AppConfig): ListTrash =>
        // The retention only dates the rows here; what acts on it is the sweep (docs/09 §9.2).
        new ListTrash(files, config.get('TRASH_RETENTION_DAYS')),
      inject: [FileRepository, AppConfig],
    },
    {
      provide: DeleteTrashItem,
      useFactory: (
        files: FileRepository,
        fileRefs: FileRefRepository,
        storage: FileStorage,
        unitOfWork: UnitOfWork,
      ): DeleteTrashItem => new DeleteTrashItem(files, fileRefs, storage, unitOfWork),
      inject: [FileRepository, FileRefRepository, FileStorage, UnitOfWork],
    },
    {
      provide: EmptyTrash,
      useFactory: (
        files: FileRepository,
        fileRefs: FileRefRepository,
        storage: FileStorage,
        unitOfWork: UnitOfWork,
      ): EmptyTrash => new EmptyTrash(files, fileRefs, storage, unitOfWork),
      inject: [FileRepository, FileRefRepository, FileStorage, UnitOfWork],
    },
    {
      provide: DownloadTrashItem,
      useFactory: (
        files: FileRepository,
        fileRefs: FileRefRepository,
        libraries: LibraryRepository,
        reader: LibraryReader,
        storage: FileStorage,
        clock: Clock,
        config: AppConfig,
      ): DownloadTrashItem =>
        new DownloadTrashItem(
          files,
          fileRefs,
          new DocumentFileBytes(libraries, fileRefs, reader, storage, clock),
          storage,
          config.get('SIGNED_URL_TTL_SEC'),
        ),
      inject: [
        FileRepository,
        FileRefRepository,
        LibraryRepository,
        LibraryReader,
        FileStorage,
        Clock,
        AppConfig,
      ],
    },
    {
      provide: RestoreTrashItem,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        fileRefs: FileRefRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): RestoreTrashItem =>
        new RestoreTrashItem(documents, files, fileRefs, events, queue, unitOfWork),
      inject: [
        DocumentRepository,
        FileRepository,
        FileRefRepository,
        DocumentEventRepository,
        JobQueue,
        UnitOfWork,
      ],
    },
  ],
})
export class TrashAdminModule {}
