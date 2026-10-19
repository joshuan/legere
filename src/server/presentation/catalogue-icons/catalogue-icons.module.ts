import { Module } from '@nestjs/common';
import { ManageCatalogueIcons } from '../../application/catalogues/manage-catalogue-icons';
import { FileStorage } from '../../application/ports/file-storage';
import { SubjectRepository } from '../../domain/repositories/subject.repository';
import { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SharpCatalogueIconRenderer } from '../../infrastructure/pdf/sharp-catalogue-icon-renderer';
import { RolesGuard } from '../auth/roles.guard';
import { sessionGuardProviders } from '../auth/session-guard.providers';
import {
  AdminCatalogueIconsController,
  CatalogueIconImagesController,
} from './catalogue-icons.controller';

@Module({
  controllers: [AdminCatalogueIconsController, CatalogueIconImagesController],
  providers: [
    ...sessionGuardProviders,
    RolesGuard,
    {
      provide: ManageCatalogueIcons,
      useFactory: (
        subjects: SubjectRepository,
        kinds: SubjectKindRepository,
        storage: FileStorage,
      ) => new ManageCatalogueIcons(subjects, kinds, storage, new SharpCatalogueIconRenderer()),
      inject: [SubjectRepository, SubjectKindRepository, FileStorage],
    },
  ],
})
export class CatalogueIconsModule {}
