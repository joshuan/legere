import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthInfrastructureModule } from './infrastructure/auth/auth-infrastructure.module';
import { AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { LibraryModule } from './infrastructure/library/library.module';
import { buildLoggerOptions } from './infrastructure/logging/logger.options';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { QueueModule } from './infrastructure/queue/queue.module';
import { AuthModule } from './presentation/auth/auth.module';
import { DomainExceptionFilter } from './presentation/http/domain-exception.filter';
import { HealthModule } from './presentation/health/health.module';
import { LibrariesModule } from './presentation/libraries/libraries.module';
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
    LibraryModule,
    QueueModule,
    AuthModule,
    UsersModule,
    LibrariesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
