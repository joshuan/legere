import { register } from 'node:module';

// Match the development server's TypeScript transform. Node's built-in strip-only loader cannot
// load the repository's TypeScript modules consistently (and does not emit Nest metadata).
register('./swc-esm-loader.mjs', import.meta.url);
await import('./migrate-queue.ts');
