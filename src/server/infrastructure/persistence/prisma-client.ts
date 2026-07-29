import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { PrismaTx } from './prisma-unit-of-work';
import type { PrismaService } from './prisma.service';

// The handle crossing the application boundary is opaque (`unknown`), so narrowing it back to a
// Prisma transaction client needs a runtime type guard — type assertions are forbidden (docs/14 §14.1).
// A transaction client always exposes $queryRaw; the deny-listed members ($connect/$transaction/…)
// are absent, which is what distinguishes it from a bare object.
export function isPrismaTx(handle: TransactionHandle): handle is PrismaTx {
  return typeof handle === 'object' && handle !== null && '$queryRaw' in handle;
}

// Repositories run on the supplied transaction when there is one, otherwise on the shared client
// (docs/06 §6.3.4). A free function rather than a base class on purpose: a subclass without its own
// constructor inherits no `design:paramtypes`, so Nest would inject nothing and every query would
// fail on an undefined client.
export function clientOf(prisma: PrismaService, tx?: TransactionHandle): PrismaTx {
  return tx !== undefined && isPrismaTx(tx) ? tx : prisma;
}
