import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  UnitOfWork,
  type TransactionHandle,
} from '../../src/server/application/ports/unit-of-work';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { isPrismaTx } from '../../src/server/infrastructure/persistence/prisma-repository.base';
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
    const created = await prisma.category.create({
      data: { slug: 'round-trip', name: 'Round trip', description: 'example' },
    });

    const loaded = await prisma.category.findFirst({ where: { slug: 'round-trip' } });

    expect(loaded?.id).toBe(created.id);
    expect(loaded?.name).toBe('Round trip');
    expect(loaded?.deletedAt).toBeNull();
  });

  it('starts each test with an empty database (truncation between tests)', async () => {
    const count = await prisma.category.count();
    expect(count).toBe(0);
  });

  it('commits every write of a UnitOfWork run together', async () => {
    await unitOfWork.run(async (tx) => {
      const client = asClient(tx);
      await client.category.create({ data: { slug: 'first', name: 'First' } });
      await client.category.create({ data: { slug: 'second', name: 'Second' } });
    });

    const slugs = await prisma.category.findMany({
      select: { slug: true },
      orderBy: { slug: 'asc' },
    });
    expect(slugs.map((row) => row.slug)).toEqual(['first', 'second']);
  });

  it('rolls back every write when the UnitOfWork callback throws', async () => {
    await expect(
      unitOfWork.run(async (tx) => {
        const client = asClient(tx);
        await client.category.create({ data: { slug: 'kept-if-committed', name: 'Doomed' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await prisma.category.count()).toBe(0);
  });

  it('enforces the soft-delete-aware partial unique index on active rows', async () => {
    await prisma.category.create({ data: { slug: 'unique-me', name: 'One' } });

    await expect(
      prisma.category.create({ data: { slug: 'unique-me', name: 'Two' } }),
    ).rejects.toThrow();

    // The same slug is allowed again once the previous row is soft-deleted.
    await prisma.category.updateMany({
      where: { slug: 'unique-me' },
      data: { deletedAt: new Date() },
    });
    await expect(
      prisma.category.create({ data: { slug: 'unique-me', name: 'Three' } }),
    ).resolves.toMatchObject({ slug: 'unique-me' });
  });
});

// The transaction handle is opaque to application code; tests narrow it with the very guard
// repositories use (docs/06 §6.3.4).
function asClient(tx: TransactionHandle): PrismaTx {
  if (!isPrismaTx(tx)) throw new Error('Unexpected transaction handle');
  return tx;
}
