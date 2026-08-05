import { Module } from '@nestjs/common';
import {
  DeleteDocument,
  GetDocument,
  ListDocumentEvents,
  ListDocumentYears,
  ListDocuments,
  UpdateDocumentMeta,
} from '../../application/documents/manage-documents';
import {
  DownloadDocumentSource,
  GetDocumentArtifactUrl,
  GetDocumentMarkdown,
  type DownloadSettings,
} from '../../application/documents/download-document';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import { Clock } from '../../application/ports/clock';
import { FileStorage } from '../../application/ports/file-storage';
import { LibraryReader } from '../../application/ports/library-reader';
import { JobQueue } from '../../application/ports/job-queue';
import { MimeDetector } from '../../application/ports/mime-detector';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { PersonRepository } from '../../domain/repositories/person.repository';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { DocumentAccessGuard } from './document-access.guard';
import { UploadDocument } from '../../application/documents/upload-document';
import { DocumentsController } from './documents.controller';

function downloadSettings(config: AppConfig): DownloadSettings {
  return { signedUrlTtlSec: config.get('SIGNED_URL_TTL_SEC') };
}

// Documents (docs/06 §6.5): the read model, the bytes, metadata editing, deletion and reprocessing.
@Module({
  controllers: [DocumentsController],
  providers: [
    ...sessionGuardProviders,
    DocumentAccessGuard,
    {
      provide: ListDocuments,
      useFactory: (documents: DocumentRepository): ListDocuments => new ListDocuments(documents),
      inject: [DocumentRepository],
    },
    { provide: GetDocument, useFactory: (): GetDocument => new GetDocument() },
    {
      provide: UploadDocument,
      useFactory: (
        documents: DocumentRepository,
        events: DocumentEventRepository,
        files: FileStorage,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): UploadDocument => new UploadDocument(documents, events, files, mime, queue, unitOfWork),
      inject: [
        DocumentRepository,
        DocumentEventRepository,
        FileStorage,
        MimeDetector,
        JobQueue,
        UnitOfWork,
      ],
    },
    {
      provide: UpdateDocumentMeta,
      useFactory: (
        documents: DocumentRepository,
        documentTypes: DocumentTypeRepository,
        events: DocumentEventRepository,
        people: PersonRepository,
        subjects: SubjectRepository,
      ): UpdateDocumentMeta =>
        new UpdateDocumentMeta(documents, documentTypes, events, people, subjects),
      inject: [
        DocumentRepository,
        DocumentTypeRepository,
        DocumentEventRepository,
        PersonRepository,
        SubjectRepository,
      ],
    },
    {
      provide: DeleteDocument,
      useFactory: (documents: DocumentRepository, clock: Clock): DeleteDocument =>
        new DeleteDocument(documents, clock),
      inject: [DocumentRepository, Clock],
    },
    {
      provide: DownloadDocumentSource,
      useFactory: (
        libraries: LibraryRepository,
        fileRefs: FileRefRepository,
        reader: LibraryReader,
        files: FileStorage,
        clock: Clock,
        config: AppConfig,
      ): DownloadDocumentSource =>
        new DownloadDocumentSource(
          libraries,
          fileRefs,
          reader,
          files,
          clock,
          downloadSettings(config),
        ),
      inject: [LibraryRepository, FileRefRepository, LibraryReader, FileStorage, Clock, AppConfig],
    },
    {
      provide: GetDocumentArtifactUrl,
      useFactory: (
        files: FileStorage,
        source: DownloadDocumentSource,
        config: AppConfig,
      ): GetDocumentArtifactUrl =>
        new GetDocumentArtifactUrl(files, source, downloadSettings(config)),
      inject: [FileStorage, DownloadDocumentSource, AppConfig],
    },
    {
      provide: GetDocumentMarkdown,
      useFactory: (): GetDocumentMarkdown => new GetDocumentMarkdown(),
    },
    {
      provide: ListDocumentEvents,
      useFactory: (events: DocumentEventRepository): ListDocumentEvents =>
        new ListDocumentEvents(events),
      inject: [DocumentEventRepository],
    },
    {
      provide: ListDocumentYears,
      useFactory: (documents: DocumentRepository): ListDocumentYears =>
        new ListDocumentYears(documents),
      inject: [DocumentRepository],
    },
    {
      provide: ReprocessDocument,
      useFactory: (
        documents: DocumentRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
      ): ReprocessDocument => new ReprocessDocument(documents, events, queue),
      inject: [DocumentRepository, DocumentEventRepository, JobQueue],
    },
  ],
})
export class DocumentsModule {}
