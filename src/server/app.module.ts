import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AiModule } from './infrastructure/ai/ai.module';
import { AuthInfrastructureModule } from './infrastructure/auth/auth-infrastructure.module';
import { AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { buildLoggerOptions } from './infrastructure/logging/logger.options';
import { PdfModule } from './infrastructure/pdf/pdf.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { StorageModule } from './infrastructure/storage/storage.module';
import { AuthModule } from './presentation/auth/auth.module';
import { DocumentTypesModule } from './presentation/document-types/document-types.module';
import { PeopleModule } from './presentation/people/people.module';
import { SubjectsModule } from './presentation/subjects/subjects.module';
import { CollectionsModule } from './presentation/collections/collections.module';
import { DocumentsModule } from './presentation/documents/documents.module';
import { DomainExceptionFilter } from './presentation/http/domain-exception.filter';
import { HealthModule } from './presentation/health/health.module';
import { JobsModule } from './presentation/jobs/jobs.module';
import { LibrariesModule } from './presentation/libraries/libraries.module';
import { QueueAdminModule } from './presentation/queue/queue-admin.module';
import { ScanSetsModule } from './presentation/scan-sets/scan-sets.module';
import { SearchModule } from './presentation/search/search.module';
import { UsersModule } from './presentation/users/users.module';

// Composition root (docs/06 §6.5). Feature modules are added as milestones land.
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: buildLoggerOptions,
    }),
    // Per-IP rate limiting (docs/06 §6.4, docs/08 §8.4). The guard is applied per route rather than
    // globally, so it covers /api/auth/* and /api/invites/* without throttling the health probe.
    ThrottlerModule.forRoot([{ name: 'auth', ttl: 60_000, limit: 20 }]),
    PersistenceModule,
    AuthInfrastructureModule,
    StorageModule,
    PdfModule,
    AiModule,
    QueueModule,
    AuthModule,
    UsersModule,
    LibrariesModule,
    DocumentsModule,
    DocumentTypesModule,
    PeopleModule,
    SubjectsModule,
    SearchModule,
    CollectionsModule,
    ScanSetsModule,
    QueueAdminModule,
    JobsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
