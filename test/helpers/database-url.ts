// Integration suites truncate tables and replay migration DDL. Refuse an ordinary application
// database before Prisma (or a Nest test application) has a chance to connect to it.
export function testDatabaseUrl(value: string | undefined, name: string): URL {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL for a dedicated database ending in _test`);
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !/^\/[A-Za-z0-9_]+_test$/.test(url.pathname)
  ) {
    throw new Error(`${name} must name a dedicated PostgreSQL database ending in _test`);
  }
  return url;
}

export function validateTestDatabaseUrls(): void {
  const runtime = testDatabaseUrl(process.env.DATABASE_URL, 'DATABASE_URL');
  const migration = testDatabaseUrl(
    process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
    'MIGRATION_DATABASE_URL',
  );
  if (
    runtime.hostname !== migration.hostname ||
    (runtime.port || '5432') !== (migration.port || '5432') ||
    runtime.pathname !== migration.pathname
  ) {
    throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL must name the same test database');
  }
}
