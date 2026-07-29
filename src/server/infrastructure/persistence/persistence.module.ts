import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// Persistence wiring (docs/06 §6.5). Repositories + UnitOfWork are added in M1.2; for now it provides
// the Prisma client so the health check can reach the database.
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PersistenceModule {}
