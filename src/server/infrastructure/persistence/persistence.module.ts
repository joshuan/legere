import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import { CollectionRepository } from '../../domain/repositories/collection.repository';
import { DocumentChunkRepository } from '../../domain/repositories/document-chunk.repository';
import { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import { PersonRepository } from '../../domain/repositories/person.repository';
import { SettingsRepository } from '../../domain/repositories/settings.repository';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
import { DocumentLinkRepository } from '../../domain/repositories/document-link.repository';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { FileRepository } from '../../domain/repositories/file.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { ApiTokenRepository } from '../../domain/repositories/api-token.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { PrismaCategoryRepository } from './prisma-document-type.repository';
import { PrismaCollectionRepository } from './prisma-collection.repository';
import { PrismaDocumentChunkRepository } from './prisma-document-chunk.repository';
import { PrismaDocumentEventRepository } from './prisma-document-event.repository';
import { PrismaDocumentLinkRepository } from './prisma-document-link.repository';
import { PrismaDocumentRepository } from './prisma-document.repository';
import { PrismaPersonRepository } from './prisma-person.repository';
import { PrismaSettingsRepository } from './prisma-settings.repository';
import { PrismaSubjectKindRepository } from './prisma-subject-kind.repository';
import { PrismaSubjectRepository } from './prisma-subject.repository';
import { PrismaEmailVerificationRepository } from './prisma-email-verification.repository';
import { PrismaFileRefRepository } from './prisma-file-ref.repository';
import { PrismaFileRepository } from './prisma-file.repository';
import { PrismaLibraryRepository } from './prisma-library.repository';
import { PrismaPasswordResetRepository } from './prisma-password-reset.repository';
import { PrismaScanRunRepository } from './prisma-scan-run.repository';
import { PrismaApiTokenRepository } from './prisma-api-token.repository';
import { PrismaSessionRepository } from './prisma-session.repository';
import { PrismaUnitOfWork } from './prisma-unit-of-work';
import { PrismaUserInviteRepository } from './prisma-user-invite.repository';
import { PrismaUserRepository } from './prisma-user.repository';
import { PrismaService } from './prisma.service';

// Persistence wiring (docs/06 §6.5): the Prisma client, the UnitOfWork port, and the repository
// ports bound to their Prisma implementations. Global so feature modules inject repositories
// without importing it explicitly.
const REPOSITORIES = [
  { provide: UserRepository, useClass: PrismaUserRepository },
  { provide: SessionRepository, useClass: PrismaSessionRepository },
  { provide: ApiTokenRepository, useClass: PrismaApiTokenRepository },
  { provide: EmailVerificationRepository, useClass: PrismaEmailVerificationRepository },
  { provide: UserInviteRepository, useClass: PrismaUserInviteRepository },
  { provide: PasswordResetRepository, useClass: PrismaPasswordResetRepository },
  { provide: LibraryRepository, useClass: PrismaLibraryRepository },
  { provide: ScanRunRepository, useClass: PrismaScanRunRepository },
  { provide: FileRefRepository, useClass: PrismaFileRefRepository },
  { provide: FileRepository, useClass: PrismaFileRepository },
  { provide: DocumentRepository, useClass: PrismaDocumentRepository },
  { provide: DocumentLinkRepository, useClass: PrismaDocumentLinkRepository },
  { provide: DocumentEventRepository, useClass: PrismaDocumentEventRepository },
  { provide: PersonRepository, useClass: PrismaPersonRepository },
  { provide: SubjectRepository, useClass: PrismaSubjectRepository },
  { provide: SubjectKindRepository, useClass: PrismaSubjectKindRepository },
  { provide: SettingsRepository, useClass: PrismaSettingsRepository },
  { provide: DocumentChunkRepository, useClass: PrismaDocumentChunkRepository },
  { provide: DocumentTypeRepository, useClass: PrismaCategoryRepository },
  { provide: CollectionRepository, useClass: PrismaCollectionRepository },
];

@Global()
@Module({
  providers: [PrismaService, { provide: UnitOfWork, useClass: PrismaUnitOfWork }, ...REPOSITORIES],
  exports: [
    PrismaService,
    UnitOfWork,
    UserRepository,
    SessionRepository,
    ApiTokenRepository,
    EmailVerificationRepository,
    UserInviteRepository,
    PasswordResetRepository,
    LibraryRepository,
    ScanRunRepository,
    FileRefRepository,
    FileRepository,
    DocumentRepository,
    DocumentLinkRepository,
    DocumentEventRepository,
    PersonRepository,
    SubjectRepository,
    SubjectKindRepository,
    SettingsRepository,
    DocumentChunkRepository,
    DocumentTypeRepository,
    CollectionRepository,
  ],
})
export class PersistenceModule {}
