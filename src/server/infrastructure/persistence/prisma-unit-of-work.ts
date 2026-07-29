import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { UnitOfWork, type TransactionHandle } from '../../application/ports/unit-of-work';
import { PrismaService } from './prisma.service';

// Prisma transaction client: what repositories actually receive as the opaque TransactionHandle.
export type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class PrismaUnitOfWork extends UnitOfWork {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  run<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    return this.prisma.$transaction((tx) => fn(tx));
  }
}
