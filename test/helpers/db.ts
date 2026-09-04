import { PrismaClient } from '@prisma/client';
import { configSchema } from '../../src/server/infrastructure/config/config.schema';

// The width of `document_chunks.embedding` (docs/04 §4.3), taken from the one place that decides it
// rather than repeated as a literal in every fixture: a migration that changes the column changes
// the default beside it, and the suites follow without being edited.
export const EMBEDDING_WIDTH: number = configSchema.shape.EMBEDDING_DIMENSIONS.parse(undefined);

// Zeros with the given head, at that width — what a test hands a pgvector column.
export function embeddingOf(head: readonly number[]): number[] {
  return Array.from({ length: EMBEDDING_WIDTH }, (_, index) => head[index] ?? 0);
}

// Integration-test harness (docs/14 §14.8): one client for the whole run, plus a truncate helper
// used between tests so each one starts from a known-empty database.
let client: PrismaClient | null = null;
let migrationClient: PrismaClient | null = null;

export function testPrisma(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}

// The test application deliberately runs as the production DML-only role in CI (SEC-43). Cleanup
// and migration-fixture DDL are test-runner operations, so they use the same separate owner URL as
// `prisma migrate deploy`; locally it falls back to DATABASE_URL and changes nothing.
export function migrationPrisma(): PrismaClient {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (url === undefined) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  migrationClient ??= new PrismaClient({
    datasources: {
      db: { url },
    },
  });
  return migrationClient;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
  if (migrationClient) {
    await migrationClient.$disconnect();
    migrationClient = null;
  }
}

// Truncate every application table in one statement. Discovered from the catalog rather than
// hard-coded so a new model can never be silently left behind; _prisma_migrations is preserved
// (the schema itself must survive) and pg-boss owns a separate schema, so it is untouched.
// RESTART IDENTITY CASCADE clears dependent rows regardless of FK order.
export async function truncateAll(): Promise<void> {
  const prisma = migrationPrisma();
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((row) => `"public"."${row.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
