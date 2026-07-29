import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// The Prisma client provider (docs/06 §6.2). Connection is lazy (the first query connects) so a DB
// outage does not prevent the process from starting — the health endpoint reports it instead.
// Graceful shutdown: Nest shutdown hooks are enabled in bootstrap, so onModuleDestroy runs on
// SIGTERM and disconnects the pool before exit (docs/06 §6.8).
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
