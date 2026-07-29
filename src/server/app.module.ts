import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuthInfrastructureModule } from './infrastructure/auth/auth-infrastructure.module';
import { AppConfig } from './infrastructure/config/app-config';
import { ConfigModule } from './infrastructure/config/config.module';
import { buildLoggerOptions } from './infrastructure/logging/logger.options';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { DomainExceptionFilter } from './presentation/http/domain-exception.filter';
import { HealthModule } from './presentation/health/health.module';

// Composition root (docs/06 §6.5). Feature modules are added as milestones land.
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: buildLoggerOptions,
    }),
    PersistenceModule,
    AuthInfrastructureModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: DomainExceptionFilter }],
})
export class AppModule {}
