import { readFileSync } from 'node:fs';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Two projects (docs/14 §14.8): `server` runs in Node and transpiles with unplugin-swc so Nest DI
// gets decorator metadata (ADR-017); `web` runs in jsdom for component tests. The SWC jsc config is
// loaded from `.swcrc` — the single source of truth also used by the dev runner — because
// unplugin-swc does not read `.swcrc` automatically.
const { jsc } = JSON.parse(readFileSync(new URL('./.swcrc', import.meta.url), 'utf8'));

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [swc.vite({ jsc })],
        test: {
          name: 'server',
          environment: 'node',
          globals: true,
          // Server tests share one database and the integration harness truncates between tests,
          // so files must not run concurrently (docs/14 §14.8).
          fileParallelism: false,
          setupFiles: ['./test/setup.server.ts'],
          include: [
            'server/**/*.test.ts',
            'src/server/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'test/**/*.test.ts',
          ],
        },
      },
      {
        plugins: [swc.vite({ jsc })],
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./test/setup.web.ts'],
          include: ['src/web/**/*.test.{ts,tsx}', 'src/app/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
