import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// The Prisma client provider (docs/06 §6.2). Connection is lazy (first query connects) so a DB
// outage does not prevent the process from starting — the health endpoint reports the outage
// instead. Graceful shutdown disconnects on module destroy. Repositories + UnitOfWork land in M1.2.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
