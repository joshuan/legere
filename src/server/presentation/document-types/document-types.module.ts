import { Module } from '@nestjs/common';
import { AuthenticateSession } from '../../application/auth/authenticate-session';
import {
  CreateDocumentType,
  DeleteDocumentType,
  ListDocumentTypes,
  UpdateDocumentType,
} from '../../application/document-types/manage-document-types';
import { Clock } from '../../application/ports/clock';
import { SessionTokens } from '../../application/ports/session-tokens';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { SessionGuard } from '../auth/session.guard';
import { AdminDocumentTypesController, DocumentTypesController } from './document-types.controller';

// DocumentTypes (docs/06 §6.5): the managed reference list the classifier and the filters share.
@Module({
  controllers: [DocumentTypesController, AdminDocumentTypesController],
  providers: [
    SessionGuard,
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
      provide: ListDocumentTypes,
      useFactory: (documentTypes: DocumentTypeRepository): ListDocumentTypes =>
        new ListDocumentTypes(documentTypes),
      inject: [DocumentTypeRepository],
    },
    {
      provide: CreateDocumentType,
      useFactory: (documentTypes: DocumentTypeRepository): CreateDocumentType =>
        new CreateDocumentType(documentTypes),
      inject: [DocumentTypeRepository],
    },
    {
      provide: UpdateDocumentType,
      useFactory: (documentTypes: DocumentTypeRepository): UpdateDocumentType =>
        new UpdateDocumentType(documentTypes),
      inject: [DocumentTypeRepository],
    },
    {
      provide: DeleteDocumentType,
      useFactory: (
        documentTypes: DocumentTypeRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ): DeleteDocumentType => new DeleteDocumentType(documentTypes, unitOfWork, clock),
      inject: [DocumentTypeRepository, UnitOfWork, Clock],
    },
  ],
})
export class DocumentTypesModule {}
