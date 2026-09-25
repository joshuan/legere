import { existsSync } from 'node:fs';
import { register } from 'node:module';

// Prisma and the dev server both read the local environment. The queue schema must be migrated
// against that same database; explicit CI/container environment variables keep precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

// Match the development server's TypeScript transform. Node's built-in strip-only loader cannot
// load the repository's TypeScript modules consistently (and does not emit Nest metadata).
register('./swc-esm-loader.mjs', import.meta.url);
const { migrateQueue } = await import('./migrate-queue.ts');
await migrateQueue();
