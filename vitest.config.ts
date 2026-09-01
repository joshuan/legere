import { createNestNextVitestConfig } from '@joshuan/tooling/vitest';

export default createNestNextVitestConfig({
  rootDirectory: import.meta.dirname,
  serverSetupFiles: ['./test/setup.server.ts'],
  webSetupFiles: ['./test/setup.web.ts'],
  coverage: {
    provider: 'v8',
    include: ['src/server/domain/**', 'src/server/application/**'],
    exclude: ['**/*.test.ts', 'src/server/application/jobs/processing-settings.ts'],
    reporter: ['text-summary', 'html'],
    thresholds: { lines: 90 },
  },
});
