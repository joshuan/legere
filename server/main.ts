import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SpikeModule } from '../src/server/spike/spike.module';
import { SpikeService } from '../src/server/spike/spike.service';

// M0.3 spike bootstrap: proves the SWC dev runner transpiles decorator metadata so Nest DI
// resolves constructor-injected providers. Expanded to the one-process Express + Nest + Next
// bootstrap (docs/02 §2.2) in M0.4.
export async function bootstrap({ dev }: { dev: boolean }): Promise<void> {
  const logger = new Logger('DevBootstrap');
  const app = await NestFactory.createApplicationContext(SpikeModule, {
    logger: ['error', 'warn', 'log'],
  });
  const message = app.get(SpikeService).run();
  logger.log(`Nest DI resolved under SWC (dev=${dev}): ${message}`);
  await app.close();
}
