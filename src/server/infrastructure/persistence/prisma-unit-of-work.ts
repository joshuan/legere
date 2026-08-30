import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  UnitOfWork,
  type TransactionBounds,
  type TransactionHandle,
} from '../../application/ports/unit-of-work';
import { PrismaService } from './prisma.service';

// Prisma transaction client: what repositories actually receive as the opaque TransactionHandle.
export type PrismaTx = Prisma.TransactionClient;

// Prisma's own wait for a free connection before it will open a transaction at all. Named because
// the arithmetic below floors on it: a bound may raise this number, never lower it, so a caller
// asking for a longer transaction cannot accidentally get a shorter queue than it has today.
const PRISMA_DEFAULT_MAX_WAIT_MS = 2_000;

@Injectable()
export class PrismaUnitOfWork extends UnitOfWork {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  run<T>(fn: (tx: TransactionHandle) => Promise<T>, bounds?: TransactionBounds): Promise<T> {
    // No bound asked for, no options passed: the driver's defaults, exactly as before (docs/06
    // §6.3.4). Every caller but the chunk replacement writes a handful of rows and wants them.
    if (bounds === undefined) return this.prisma.$transaction((tx) => fn(tx));
    return this.prisma.$transaction((tx) => fn(tx), transactionOptions(bounds));
  }
}

// Exported so the arithmetic can be read at a unit test rather than only through a real
// transaction: `timeout` is the caller's bound as given, `maxWait` is derived from it.
export function transactionOptions(bounds: TransactionBounds): {
  timeout: number;
  maxWait: number;
} {
  return {
    timeout: bounds.timeoutMs,
    // `maxWait` bounds waiting for a connection, not the work — but the load that makes this work
    // slow is the same load that keeps the pool busy, so raising one and leaving the other at two
    // seconds only moves the failure from the commit to the start. Half the bound, floored at the
    // driver's own default: queueing can never cost a caller more than working.
    maxWait: Math.max(PRISMA_DEFAULT_MAX_WAIT_MS, Math.round(bounds.timeoutMs / 2)),
  };
}
