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
    // The acceptance floor of docs/14 §14.8: the two framework-free layers, where the rules of the
    // product live, stay above 90% of lines. No global threshold — a number covering generated
    // Prisma mappers and Nest modules measures ceremony, not risk. `npm run test:coverage` (and CI)
    // fails below the floor; `npm test` stays fast and reports nothing.
    coverage: {
      provider: 'v8',
      include: ['src/server/domain/**', 'src/server/application/**'],
      // Type-only files hold no statements; V8 reports them as 0% and drags the average down.
      exclude: ['**/*.test.ts', 'src/server/application/jobs/processing-settings.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: { lines: 90 },
    },
    // Server tests share one database and the integration harness truncates between tests, so test
    // files must not run concurrently (docs/14 §14.8). This has to live at the root: a project-level
    // `fileParallelism` is ignored, which lets two files truncate each other's rows mid-flow.
    fileParallelism: false,
    projects: [
      {
        plugins: [swc.vite({ jsc })],
        test: {
          name: 'server',
          environment: 'node',
          globals: true,
          // Child processes, kept apart from the web project's worker threads: msw patches Node's
          // http layer, and any shared runtime lets that interception swallow supertest's own
          // requests, which then fail to parse their responses.
          pool: 'forks',
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
          pool: 'threads',
          setupFiles: ['./test/setup.web.ts'],
          include: ['src/web/**/*.test.{ts,tsx}', 'src/app/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
