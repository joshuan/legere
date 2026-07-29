import { Module } from '@nestjs/common';
import { CheckHealth } from '../../application/health/check-health';
import { DbHealthChecker, QueueHealthChecker } from '../../application/health/ports';
import { PrismaDbHealthChecker } from '../../infrastructure/health/prisma-db-health-checker';
import { PgBossQueueHealthChecker } from '../../infrastructure/health/queue-health-checker';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: DbHealthChecker, useClass: PrismaDbHealthChecker },
    { provide: QueueHealthChecker, useClass: PgBossQueueHealthChecker },
    {
      provide: CheckHealth,
      useFactory: (db: DbHealthChecker, queue: QueueHealthChecker): CheckHealth =>
        new CheckHealth(db, queue),
      inject: [DbHealthChecker, QueueHealthChecker],
    },
  ],
})
export class HealthModule {}
