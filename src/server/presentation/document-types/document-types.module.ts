import { Module } from '@nestjs/common';
import {
  CreateDocumentType,
  DeleteDocumentType,
  ListDocumentTypes,
  UpdateDocumentType,
} from '../../application/document-types/manage-document-types';
import { Clock } from '../../application/ports/clock';
import { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import { AdminDocumentTypesController, DocumentTypesController } from './document-types.controller';

// DocumentTypes (docs/06 §6.5): the managed reference list the classifier and the filters share.
@Module({
  controllers: [DocumentTypesController, AdminDocumentTypesController],
  providers: [
    ...sessionGuardProviders,
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
      useFactory: (documentTypes: DocumentTypeRepository, clock: Clock): DeleteDocumentType =>
        new DeleteDocumentType(documentTypes, clock),
      inject: [DocumentTypeRepository, Clock],
    },
  ],
})
export class DocumentTypesModule {}
