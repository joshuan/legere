import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CheckHealth } from '../../application/health/check-health';
import { ConfigModule } from '../../infrastructure/config/config.module';
import { PersistenceModule } from '../../infrastructure/persistence/persistence.module';
import { HealthController } from './health.controller';
import { HealthModule } from './health.module';

// Also the standing proof that SWC emits decorator metadata (design:paramtypes) under Vitest —
// without it Nest could not resolve these constructor-injected dependencies (ADR-017). No DB needed:
// the Prisma client connects lazily.
describe('HealthModule DI', () => {
  it('resolves the controller and its use case through the container', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule, HealthModule],
    }).compile();

    expect(moduleRef.get(HealthController)).toBeInstanceOf(HealthController);
    expect(moduleRef.get(CheckHealth)).toBeInstanceOf(CheckHealth);

    await moduleRef.close();
  });
});
