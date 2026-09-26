import { register } from 'node:module';

// No dotenv loading in this entrypoint: opt into a dedicated database explicitly before Next
// prepares the app (Next may load its own env files, so server.ts validates the final URL again).
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a dedicated *_test database');
// Next and React must render a production build with the same production runtime semantics.
// Test isolation comes from the dedicated database and explicit outbound-port overrides.
process.env.NODE_ENV = 'production';
process.env.PORT ??= '3012';
process.env.APP_BASE_URL = `http://127.0.0.1:${process.env.PORT}`;
process.env.AUTH_SECRET = 'browser-test-secret-at-least-32-characters';
process.env.LOG_LEVEL = 'silent';
process.env.LIBRARY_ROOT ??= '/tmp/legere-browser-library';
process.env.S3_ENDPOINT = 'http://in-memory-storage.test';
process.env.S3_ACCESS_KEY_ID = 'browser-fixture';
process.env.S3_SECRET_ACCESS_KEY = 'browser-fixture';
process.env.SMTP_HOST = 'smtp.fixture.test';
process.env.DOCLING_URL = '';
process.env.CLASSIFIER_API_BASE_URL = '';
process.env.EMBEDDINGS_API_BASE_URL = '';
process.env.RECEIPT_API_BASE_URL = '';
register('../../server/swc-esm-loader.mjs', import.meta.url);
await import('./server.ts');
