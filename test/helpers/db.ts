import { PrismaClient } from '@prisma/client';

// Integration-test harness (docs/14 §14.8): one client for the whole run, plus a truncate helper
// used between tests so each one starts from a known-empty database.
let client: PrismaClient | null = null;

export function testPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

// Truncate every application table in one statement. Discovered from the catalog rather than
// hard-coded so a new model can never be silently left behind; _prisma_migrations is preserved
// (the schema itself must survive) and pg-boss owns a separate schema, so it is untouched.
// RESTART IDENTITY CASCADE clears dependent rows regardless of FK order.
export async function truncateAll(): Promise<void> {
  const prisma = testPrisma();
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((row) => `"public"."${row.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
