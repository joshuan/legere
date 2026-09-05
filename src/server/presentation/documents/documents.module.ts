import { Module } from '@nestjs/common';
import {
  DeleteDocument,
  GetDocument,
  ListDocumentEvents,
  ListDocumentGroups,
  ListDocumentYears,
  ListDocuments,
  UpdateDocumentMeta,
} from '../../application/documents/manage-documents';
import {
  AddDocumentFile,
  CombineDocuments,
  ReorderDocumentFiles,
  ReplaceDocumentFile,
  SplitDocumentFile,
  SuggestDocumentFileCrop,
  UpdateDocumentFile,
} from '../../application/documents/compose-document';
import {
  MoveDocumentPages,
  RemoveDocumentPage,
  ReorderDocumentPages,
  SplitDocumentAtPages,
  UpdateDocumentPage,
} from '../../application/documents/arrange-pages';
import { DocumentFileBytes } from '../../application/documents/document-file-bytes';
import {
  CreateDocumentLink,
  DeleteDocumentLink,
  ListDocumentLinks,
  SuggestDocumentLinks,
} from '../../application/documents/document-links';
import {
  DownloadDocumentCanonical,
  DownloadDocumentFile,
  GetDocumentArtifactUrl,
  GetDocumentFilePageThumb,
  GetDocumentMarkdown,
  type DownloadSettings,
  type PageThumbSettings,
} from '../../application/documents/download-document';
import { ReprocessDocument } from '../../application/documents/reprocess-document';
import { GetDocumentProcessingState } from '../../application/documents/get-document-processing-state';
import {
  GroupingCandidateReader,
  SuggestGroupings,
} from '../../application/documents/suggest-groupings';
import { Clock } from '../../application/ports/clock';
import { FileStorage } from '../../application/ports/file-storage';
import { ImageTool } from '../../application/ports/image-tool';
import { LibraryReader } from '../../application/ports/library-reader';
import { JobQueue } from '../../application/ports/job-queue';
import { QueueSettings } from '../../application/queue/queue-settings';
import { PdfToolbox } from '../../application/ports/pdf-toolbox';
import { MimeDetector } from '../../application/ports/mime-detector';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { CollectionRepository } from '../../domain/repositories/collection.repository';
import { DocumentLinkRepository } from '../../domain/repositories/document-link.repository';
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

// A page of a file is shown at the size a list thumbnail is shown at, because that is what it is
// (docs/09 §9.2).
function pageThumbSettings(config: AppConfig): PageThumbSettings {
  return { ...downloadSettings(config), thumbMaxDim: config.get('THUMB_MAX_DIM') };
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
        queue: JobQueue,
      ): UpdateDocumentMeta =>
        new UpdateDocumentMeta(documents, documentTypes, events, people, subjects, queue),
      inject: [
        DocumentRepository,
        DocumentTypeRepository,
        DocumentEventRepository,
        PersonRepository,
        SubjectRepository,
        JobQueue,
      ],
    },
    {
      provide: DeleteDocument,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        fileRefs: FileRefRepository,
        collections: CollectionRepository,
        storage: FileStorage,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): DeleteDocument =>
        new DeleteDocument(documents, files, fileRefs, collections, storage, unitOfWork, clock),
      inject: [
        DocumentRepository,
        FileRepository,
        FileRefRepository,
        CollectionRepository,
        FileStorage,
        UnitOfWork,
        Clock,
      ],
    },
    {
      provide: ReplaceDocumentFile,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        // The refs of a file that goes to the trash are excluded with it, on the same terms as every
        // other way in — a superseded library original must not be ingested again (docs/03 §3.3.9).
        fileRefs: FileRefRepository,
        events: DocumentEventRepository,
        storage: FileStorage,
        mime: MimeDetector,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): ReplaceDocumentFile =>
        new ReplaceDocumentFile(
          documents,
          files,
          fileRefs,
          events,
          storage,
          mime,
          queue,
          unitOfWork,
          clock,
        ),
      inject: [
        DocumentRepository,
        FileRepository,
        FileRefRepository,
        DocumentEventRepository,
        FileStorage,
        MimeDetector,
        JobQueue,
        UnitOfWork,
        Clock,
      ],
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
    // A document worked on by the page (docs/05 §5.6, ADR-025): the order, how one page lies, one
    // page removed, a cut at a boundary, and pages that change hands. Every one of them addresses
    // entries and no bytes.
    {
      provide: ReorderDocumentPages,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): ReorderDocumentPages =>
        new ReorderDocumentPages(documents, files, events, queue, unitOfWork),
      inject: [DocumentRepository, FileRepository, DocumentEventRepository, JobQueue, UnitOfWork],
    },
    {
      provide: UpdateDocumentPage,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): UpdateDocumentPage => new UpdateDocumentPage(documents, files, events, queue, unitOfWork),
      inject: [DocumentRepository, FileRepository, DocumentEventRepository, JobQueue, UnitOfWork],
    },
    {
      provide: RemoveDocumentPage,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        fileRefs: FileRefRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): RemoveDocumentPage =>
        new RemoveDocumentPage(documents, files, fileRefs, events, queue, unitOfWork, clock),
      inject: [
        DocumentRepository,
        FileRepository,
        FileRefRepository,
        DocumentEventRepository,
        JobQueue,
        UnitOfWork,
        Clock,
      ],
    },
    {
      provide: SplitDocumentAtPages,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        links: DocumentLinkRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): SplitDocumentAtPages =>
        new SplitDocumentAtPages(documents, files, links, events, queue, unitOfWork, clock),
      inject: [
        DocumentRepository,
        FileRepository,
        DocumentLinkRepository,
        DocumentEventRepository,
        JobQueue,
        UnitOfWork,
        Clock,
      ],
    },
    {
      provide: MoveDocumentPages,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        fileRefs: FileRefRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): MoveDocumentPages =>
        new MoveDocumentPages(documents, files, fileRefs, events, queue, unitOfWork, clock),
      inject: [
        DocumentRepository,
        FileRepository,
        FileRefRepository,
        DocumentEventRepository,
        JobQueue,
        UnitOfWork,
        Clock,
      ],
    },
    {
      provide: UpdateDocumentFile,
      useFactory: (
        documents: DocumentRepository,
        files: FileRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
      ): UpdateDocumentFile => new UpdateDocumentFile(documents, files, events, queue, unitOfWork),
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
        storage: FileStorage,
        queue: JobQueue,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): CombineDocuments =>
        new CombineDocuments(documents, files, events, storage, queue, unitOfWork, clock),
      inject: [
        DocumentRepository,
        FileRepository,
        DocumentEventRepository,
        FileStorage,
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
      provide: ListDocumentLinks,
      useFactory: (
        documents: DocumentRepository,
        links: DocumentLinkRepository,
      ): ListDocumentLinks => new ListDocumentLinks(documents, links),
      inject: [DocumentRepository, DocumentLinkRepository],
    },
    {
      provide: CreateDocumentLink,
      useFactory: (
        documents: DocumentRepository,
        links: DocumentLinkRepository,
        events: DocumentEventRepository,
        clock: Clock,
      ): CreateDocumentLink => new CreateDocumentLink(documents, links, events, clock),
      inject: [DocumentRepository, DocumentLinkRepository, DocumentEventRepository, Clock],
    },
    {
      provide: DeleteDocumentLink,
      useFactory: (
        documents: DocumentRepository,
        links: DocumentLinkRepository,
        events: DocumentEventRepository,
      ): DeleteDocumentLink => new DeleteDocumentLink(documents, links, events),
      inject: [DocumentRepository, DocumentLinkRepository, DocumentEventRepository],
    },
    {
      provide: SuggestDocumentLinks,
      useFactory: (
        documents: DocumentRepository,
        links: DocumentLinkRepository,
      ): SuggestDocumentLinks => new SuggestDocumentLinks(documents, links),
      inject: [DocumentRepository, DocumentLinkRepository],
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
      provide: GetDocumentFilePageThumb,
      useFactory: (
        bytes: DocumentFileBytes,
        files: FileStorage,
        pdfs: PdfToolbox,
        images: ImageTool,
        config: AppConfig,
      ): GetDocumentFilePageThumb =>
        new GetDocumentFilePageThumb(bytes, files, pdfs, images, pageThumbSettings(config)),
      inject: [DocumentFileBytes, FileStorage, PdfToolbox, ImageTool, AppConfig],
    },
    {
      provide: GetDocumentMarkdown,
      useFactory: (): GetDocumentMarkdown => new GetDocumentMarkdown(),
    },
    {
      provide: ListDocumentEvents,
      useFactory: (
        events: DocumentEventRepository,
        documents: DocumentRepository,
      ): ListDocumentEvents => new ListDocumentEvents(events, documents),
      inject: [DocumentEventRepository, DocumentRepository],
    },
    {
      provide: ListDocumentYears,
      useFactory: (documents: DocumentRepository): ListDocumentYears =>
        new ListDocumentYears(documents),
      inject: [DocumentRepository],
    },
    {
      provide: ListDocumentGroups,
      useFactory: (documents: DocumentRepository): ListDocumentGroups =>
        new ListDocumentGroups(documents),
      inject: [DocumentRepository],
    },
    {
      provide: ReprocessDocument,
      useFactory: (
        documents: DocumentRepository,
        events: DocumentEventRepository,
        queue: JobQueue,
        // What the instance is holding: a paused step is not run for the asking (docs/05 §5.4d).
        queueSettings: QueueSettings,
      ): ReprocessDocument => new ReprocessDocument(documents, events, queue, queueSettings),
      inject: [DocumentRepository, DocumentEventRepository, JobQueue, QueueSettings],
    },
    {
      provide: GetDocumentProcessingState,
      useFactory: (queueSettings: QueueSettings): GetDocumentProcessingState =>
        new GetDocumentProcessingState(queueSettings),
      inject: [QueueSettings],
    },
  ],
})
export class DocumentsModule {}
