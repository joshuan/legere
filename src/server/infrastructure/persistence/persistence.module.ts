import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from '../../application/ports/unit-of-work';
import { PrismaUnitOfWork } from './prisma-unit-of-work';
import { PrismaService } from './prisma.service';

// Persistence wiring (docs/06 §6.5): the Prisma client, the UnitOfWork port bound to its Prisma
// implementation, and (as milestones land) the repositories. Global so feature modules can inject
// repositories without importing it explicitly.
@Global()
@Module({
  providers: [PrismaService, { provide: UnitOfWork, useClass: PrismaUnitOfWork }],
  exports: [PrismaService, UnitOfWork],
})
export class PersistenceModule {}
