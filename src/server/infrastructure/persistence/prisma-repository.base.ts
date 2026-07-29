import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { PrismaTx } from './prisma-unit-of-work';
import { PrismaService } from './prisma.service';

// The handle crossing the application boundary is opaque (`unknown`), so narrowing it back to a
// Prisma transaction client needs a runtime type guard — type assertions are forbidden (docs/14 §14.1).
// A transaction client always exposes $queryRaw; the deny-listed members ($connect/$transaction/…)
// are absent, which is exactly what distinguishes it from a bare object.
export function isPrismaTx(handle: TransactionHandle): handle is PrismaTx {
  return typeof handle === 'object' && handle !== null && '$queryRaw' in handle;
}

// Base for Prisma repositories (docs/06 §6.3.4): every method takes an optional transaction handle
// and runs on it when present, otherwise on the shared client.
export abstract class PrismaRepositoryBase {
  constructor(protected readonly prisma: PrismaService) {}

  protected client(tx?: TransactionHandle): PrismaTx {
    return tx !== undefined && isPrismaTx(tx) ? tx : this.prisma;
  }
}
