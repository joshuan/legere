// Default environment for server unit/e2e tests so ConfigModule validates. Mirrors the CI dummy
// values (docs/13 §13.2); real values (e.g. CI's DATABASE_URL) already in process.env win via ??=.
// NODE_ENV is set to 'test' by Vitest and is readonly under Next's global types.
process.env.LOG_LEVEL ??= 'silent';
process.env.APP_BASE_URL ??= 'http://localhost:3000';
process.env.AUTH_SECRET ??= 'test-secret-minimum-32-characters!!';
// Defaults to a dedicated *test* database (same name CI uses), never the developer's dev database:
// the integration harness truncates every table between tests.
process.env.DATABASE_URL ??= 'postgresql://legere:legere@localhost:5432/legere_test?schema=public';
process.env.LIBRARY_ROOT ??= '/tmp/test-library';
