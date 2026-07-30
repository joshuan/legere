import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { DocumentRepository } from '../../domain/repositories/document.repository';
import { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../domain/repositories/library.repository';
import { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { SessionRepository } from '../../domain/repositories/session.repository';
import { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import { UserRepository } from '../../domain/repositories/user.repository';
import { PrismaDocumentRepository } from './prisma-document.repository';
import { PrismaEmailVerificationRepository } from './prisma-email-verification.repository';
import { PrismaFileRefRepository } from './prisma-file-ref.repository';
import { PrismaLibraryRepository } from './prisma-library.repository';
import { PrismaPasswordResetRepository } from './prisma-password-reset.repository';
import { PrismaScanRunRepository } from './prisma-scan-run.repository';
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
  { provide: EmailVerificationRepository, useClass: PrismaEmailVerificationRepository },
  { provide: UserInviteRepository, useClass: PrismaUserInviteRepository },
  { provide: PasswordResetRepository, useClass: PrismaPasswordResetRepository },
  { provide: LibraryRepository, useClass: PrismaLibraryRepository },
  { provide: ScanRunRepository, useClass: PrismaScanRunRepository },
  { provide: FileRefRepository, useClass: PrismaFileRefRepository },
  { provide: DocumentRepository, useClass: PrismaDocumentRepository },
];

@Global()
@Module({
  providers: [PrismaService, { provide: UnitOfWork, useClass: PrismaUnitOfWork }, ...REPOSITORIES],
  exports: [
    PrismaService,
    UnitOfWork,
    UserRepository,
    SessionRepository,
    EmailVerificationRepository,
    UserInviteRepository,
    PasswordResetRepository,
    LibraryRepository,
    ScanRunRepository,
    FileRefRepository,
    DocumentRepository,
  ],
})
export class PersistenceModule {}
