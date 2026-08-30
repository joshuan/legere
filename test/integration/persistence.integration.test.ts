import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  UnitOfWork,
  type TransactionHandle,
} from '../../src/server/application/ports/unit-of-work';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { isPrismaTx } from '../../src/server/infrastructure/persistence/prisma-client';
import type { PrismaTx } from '../../src/server/infrastructure/persistence/prisma-unit-of-work';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';

// Proves the integration harness works end to end (docs/14 §14.8): the module resolves a real
// Prisma client and UnitOfWork, rows round-trip, transactions commit and roll back atomically, and
// truncation isolates tests from one another.
describe('Persistence (integration)', () => {
  let prisma: PrismaService;
  let unitOfWork: UnitOfWork;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    unitOfWork = moduleRef.get(UnitOfWork);
    close = () => moduleRef.close();
    await truncateAll();
  });

  afterEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  it('round-trips a row through the injected client', async () => {
    const created = await prisma.documentType.create({
      data: { slug: 'round-trip', name: 'Round trip', description: 'example' },
    });

    const loaded = await prisma.documentType.findFirst({ where: { slug: 'round-trip' } });

    expect(loaded?.id).toBe(created.id);
    expect(loaded?.name).toBe('Round trip');
    expect(loaded?.deletedAt).toBeNull();
  });

  it('starts each test with an empty database (truncation between tests)', async () => {
    const count = await prisma.documentType.count();
    expect(count).toBe(0);
  });

  it('commits every write of a UnitOfWork run together', async () => {
    await unitOfWork.run(async (tx) => {
      const client = asClient(tx);
      await client.documentType.create({ data: { slug: 'first', name: 'First' } });
      await client.documentType.create({ data: { slug: 'second', name: 'Second' } });
    });

    const slugs = await prisma.documentType.findMany({
      select: { slug: true },
      orderBy: { slug: 'asc' },
    });
    expect(slugs.map((row) => row.slug)).toEqual(['first', 'second']);
  });

  it('rolls back every write when the UnitOfWork callback throws', async () => {
    await expect(
      unitOfWork.run(async (tx) => {
        const client = asClient(tx);
        await client.documentType.create({ data: { slug: 'kept-if-committed', name: 'Doomed' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await prisma.documentType.count()).toBe(0);
  });

  // 🔒 The two halves of M58.1's port change, against the driver that actually enforces them
  // (docs/06 §6.3.4). The first is the failure seventy-one documents on the live instance are
  // sitting in; the second is the fix, and neither is visible anywhere but here — a fake unit of
  // work has no clock and no transaction to expire.
  it('refuses a run that outlasts the default bound when it asks for none', async () => {
    await expect(
      unitOfWork.run(async (tx) => {
        await asClient(tx).$executeRawUnsafe('SELECT pg_sleep(6)');
        await asClient(tx).documentType.create({ data: { slug: 'too-slow', name: 'Too slow' } });
      }),
    ).rejects.toThrow(/5000 ms/);

    expect(await prisma.documentType.count()).toBe(0);
  });

  it('commits a run that outlasts the default bound when it asked for the time', async () => {
    await unitOfWork.run(
      async (tx) => {
        await asClient(tx).$executeRawUnsafe('SELECT pg_sleep(6)');
        await asClient(tx).documentType.create({ data: { slug: 'slow', name: 'Slow but sure' } });
      },
      { timeoutMs: 30_000 },
    );

    expect(await prisma.documentType.count()).toBe(1);
  });

  it('enforces the soft-delete-aware partial unique index on active rows', async () => {
    await prisma.documentType.create({ data: { slug: 'unique-me', name: 'One' } });

    await expect(
      prisma.documentType.create({ data: { slug: 'unique-me', name: 'Two' } }),
    ).rejects.toThrow();

    // The same slug is allowed again once the previous row is soft-deleted.
    await prisma.documentType.updateMany({
      where: { slug: 'unique-me' },
      data: { deletedAt: new Date() },
    });
    await expect(
      prisma.documentType.create({ data: { slug: 'unique-me', name: 'Three' } }),
    ).resolves.toMatchObject({ slug: 'unique-me' });
  });
});

// The transaction handle is opaque to application code; tests narrow it with the very guard
// repositories use (docs/06 §6.3.4).
function asClient(tx: TransactionHandle): PrismaTx {
  if (!isPrismaTx(tx)) throw new Error('Unexpected transaction handle');
  return tx;
}
