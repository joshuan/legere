import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import {
  DeleteDocument,
  GetDocument,
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
import { SessionTokens } from '../../application/ports/session-tokens';
import { CategoryRepository } from '../../domain/repositories/category.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { AppConfig } from '../../infrastructure/config/app-config';
import { SessionGuard } from '../auth/session.guard';
import { DocumentAccessGuard } from './document-access.guard';
import { DocumentsController } from './documents.controller';

function downloadSettings(config: AppConfig): DownloadSettings {
  return { signedUrlTtlSec: config.get('SIGNED_URL_TTL_SEC') };
}

// Documents (docs/06 §6.5): the read model, the bytes, metadata editing, deletion and reprocessing.
@Module({
  controllers: [DocumentsController],
  providers: [
    SessionGuard,
    DocumentAccessGuard,
    {
      provide: ListDocuments,
      useFactory: (documents: DocumentRepository): ListDocuments => new ListDocuments(documents),
      inject: [DocumentRepository],
    },
    { provide: GetDocument, useFactory: (): GetDocument => new GetDocument() },
    {
      provide: UpdateDocumentMeta,
      useFactory: (
        documents: DocumentRepository,
        categories: CategoryRepository,
      ): UpdateDocumentMeta => new UpdateDocumentMeta(documents, categories),
      inject: [DocumentRepository, CategoryRepository],
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
      provide: AuthenticateSession,
      useFactory: (
        sessions: SessionRepository,
        users: UserRepository,
        tokens: SessionTokens,
        clock: Clock,
      ): AuthenticateSession => new AuthenticateSession(sessions, users, tokens, clock),
      inject: [SessionRepository, UserRepository, SessionTokens, Clock],
    },
    {
      provide: ReprocessDocument,
      useFactory: (documents: DocumentRepository, queue: JobQueue): ReprocessDocument =>
        new ReprocessDocument(documents, queue),
      inject: [DocumentRepository, JobQueue],
    },
  ],
})
export class DocumentsModule {}
