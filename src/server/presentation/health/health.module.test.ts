import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import { CheckHealth } from '../../application/health/check-health';
import { AuthInfrastructureModule } from '../../infrastructure/auth/auth-infrastructure.module';
import { ConfigModule } from '../../infrastructure/config/config.module';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

// Also the standing proof that SWC emits decorator metadata (design:paramtypes) under Vitest —
// without it Nest could not resolve these constructor-injected dependencies (ADR-017). No DB needed:
// the Prisma client connects lazily.
describe('HealthModule DI', () => {
  it('resolves the controller and its use case through the container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // LoggerModule is global in AppModule; the queue's worker registry injects its logger.
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule,
        PersistenceModule,
        QueueModule,
        // Global in AppModule, and where Clock comes from: the health check remembers its answer
        // for a second rather than asking the database per caller (docs/06 §6.10).
        AuthInfrastructureModule,
        HealthModule,
      ],
    }).compile();

    expect(moduleRef.get(HealthController)).toBeInstanceOf(HealthController);
    expect(moduleRef.get(CheckHealth)).toBeInstanceOf(CheckHealth);

    await moduleRef.close();
  });
});
