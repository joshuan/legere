import { Global, Module } from '@nestjs/common';
import { AppConfig, loadConfig } from './app-config';

// Global config module (docs/06 §6.5). Parses and validates the environment once at construction;
// an invalid environment throws here and aborts bootstrap (fail fast).
@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: (): AppConfig => loadConfig() }],
  exports: [AppConfig],
})
export class ConfigModule {}
