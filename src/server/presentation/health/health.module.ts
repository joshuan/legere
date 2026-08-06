import { Module } from '@nestjs/common';
import { CheckHealth } from '../../application/health/check-health';
import { DbHealthChecker, QueueHealthChecker } from '../../application/health/ports';
import { Clock } from '../../application/ports/clock';
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
      useFactory: (db: DbHealthChecker, queue: QueueHealthChecker, clock: Clock): CheckHealth =>
        new CheckHealth(db, queue, clock),
      inject: [DbHealthChecker, QueueHealthChecker, Clock],
    },
  ],
})
export class HealthModule {}
