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
  AddDocumentFile,
  CombineDocuments,
  ReorderDocumentFiles,
  SetDocumentFileCrop,
  SplitDocumentFile,
  SuggestDocumentFileCrop,
} from '../../application/documents/compose-document';
import { DocumentFileBytes } from '../../application/documents/document-file-bytes';
import {
  DownloadDocumentCanonical,
  DownloadDocumentFile,
  GetDocumentArtifactUrl,
  GetDocumentMarkdown,
  type DownloadSettings,
} from '../../application/documents/download-document';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import {
  GroupingCandidateReader,
  SuggestGroupings,
} from '../../application/documents/suggest-groupings';
import { Clock } from '../../application/ports/clock';
import { FileStorage } from '../../application/ports/file-storage';
import { ImageTool } from '../../application/ports/image-tool';
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
import { FileRepository } from '../../domain/repositories/file.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { PrismaGroupingCandidateReader } from '../../infrastructure/persistence/prisma-grouping-candidates';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { DocumentAccessGuard } from './document-access.guard';
import { UploadDocument } from '../../application/documents/upload-document';
import { DocumentsController } from './documents.controller';

function downloadSettings(config: AppConfig): DownloadSettings {
  return { signedUrlTtlSec: config.get('SIGNED_URL_TTL_SEC') };
}

// Documents (docs/06 §6.5): the read model, the bytes, the composition of files, metadata editing,
// deletion and reprocessing.
@Module({
  controllers: [DocumentsController],
  providers: [
    ...sessionGuardProviders,
    DocumentAccessGuard,
    // The one read model that is not a repository: the grouping suggestions are a single bounded
    // query nothing else asks (docs/05 §5.6a).
    { provide: GroupingCandidateReader, useClass: PrismaGroupingCandidateReader },
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
        files: FileRepository,
        events: DocumentEventRepository,
        storage: FileStorage,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): UploadDocument =>
        new UploadDocument(documents, files, events, storage, mime, queue, unitOfWork),
      inject: [
        DocumentRepository,
        FileRepository,
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
      provide: AddDocumentFile,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        storage: FileStorage,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): AddDocumentFile =>
        new AddDocumentFile(documents, files, events, storage, mime, queue, unitOfWork),
      inject: [
        DocumentRepository,
        FileRepository,
        DocumentEventRepository,
        FileStorage,
        MimeDetector,
        JobQueue,
        UnitOfWork,
      ],
    },
    {
      provide: ReorderDocumentFiles,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): ReorderDocumentFiles =>
        new ReorderDocumentFiles(documents, files, events, queue, unitOfWork),
      inject: [DocumentRepository, FileRepository, DocumentEventRepository, JobQueue, UnitOfWork],
    },
    {
      provide: SetDocumentFileCrop,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): SetDocumentFileCrop =>
        new SetDocumentFileCrop(documents, files, events, queue, unitOfWork),
      inject: [DocumentRepository, FileRepository, DocumentEventRepository, JobQueue, UnitOfWork],
    },
    {
      provide: SplitDocumentFile,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): SplitDocumentFile => new SplitDocumentFile(documents, files, events, queue, unitOfWork),
      inject: [DocumentRepository, FileRepository, DocumentEventRepository, JobQueue, UnitOfWork],
    },
    {
      provide: CombineDocuments,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): CombineDocuments =>
        new CombineDocuments(documents, files, events, queue, unitOfWork, clock),
      inject: [
        DocumentRepository,
        FileRepository,
        DocumentEventRepository,
        JobQueue,
        UnitOfWork,
        Clock,
      ],
    },
    {
      provide: DocumentFileBytes,
      useFactory: (
        libraries: LibraryRepository,
        fileRefs: FileRefRepository,
        reader: LibraryReader,
        storage: FileStorage,
        clock: Clock,
      ): DocumentFileBytes => new DocumentFileBytes(libraries, fileRefs, reader, storage, clock),
      inject: [LibraryRepository, FileRefRepository, LibraryReader, FileStorage, Clock],
    },
    {
      provide: SuggestDocumentFileCrop,
      useFactory: (bytes: DocumentFileBytes, images: ImageTool): SuggestDocumentFileCrop =>
        new SuggestDocumentFileCrop(bytes, images),
      inject: [DocumentFileBytes, ImageTool],
    },
    {
      provide: SuggestGroupings,
      useFactory: (candidates: GroupingCandidateReader, config: AppConfig): SuggestGroupings =>
        new SuggestGroupings(candidates, { windowMinutes: config.get('GROUPING_WINDOW_MINUTES') }),
      inject: [GroupingCandidateReader, AppConfig],
    },
    {
      provide: DownloadDocumentCanonical,
      useFactory: (files: FileStorage, config: AppConfig): DownloadDocumentCanonical =>
        new DownloadDocumentCanonical(files, downloadSettings(config)),
      inject: [FileStorage, AppConfig],
    },
    {
      provide: DownloadDocumentFile,
      useFactory: (
        bytes: DocumentFileBytes,
        files: FileStorage,
        config: AppConfig,
      ): DownloadDocumentFile => new DownloadDocumentFile(bytes, files, downloadSettings(config)),
      inject: [DocumentFileBytes, FileStorage, AppConfig],
    },
    {
      provide: GetDocumentArtifactUrl,
      useFactory: (files: FileStorage, config: AppConfig): GetDocumentArtifactUrl =>
        new GetDocumentArtifactUrl(files, downloadSettings(config)),
      inject: [FileStorage, AppConfig],
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
