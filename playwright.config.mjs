import { defineConfig } from '@playwright/test';

const baseURL = process.env.BROWSER_BASE_URL ?? 'http://127.0.0.1:3012';
const widths = [320, 390, 768, 1024, 1440];
const themes = ['light', 'dark'];
if (
  process.argv.some(
    (argument) =>
      argument === '-u' || argument.startsWith('-u=') || argument.startsWith('--update-snapshots'),
  ) &&
  process.env.BROWSER_CANONICAL !== '1'
) {
  throw new Error(
    'Update visual baselines with npm run test:browser:docker -- --update-snapshots=all',
  );
}

export default defineConfig({
  testDir: './test/browser',
  testMatch: /.*\.spec\.ts/,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 100 },
  },
  fullyParallel: true,
  // Comparisons never write baselines; the explicit canonical update flag overrides this.
  updateSnapshots: 'none',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 3,
  reporter: [['list'], ['html', { open: 'never' }]],
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  use: {
    baseURL,
    browserName: 'chromium',
    // The real Chromium headless mode includes the PDF viewer; headless-shell does not.
    channel: 'chromium',
    headless: true,
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    ...widths.flatMap((width) =>
      themes.map((colorScheme) => ({
        name: `chromium-${width}-${colorScheme}`,
        dependencies: ['setup'],
        use: {
          viewport: { width, height: 960 },
          colorScheme,
          hasTouch: width <= 1024,
          storageState: 'test-results/auth/admin.json',
        },
      })),
    ),
  ],
  webServer:
    process.env.BROWSER_EXTERNAL_SERVER === '1'
      ? undefined
      : {
          command: 'node test/browser/server.mjs',
          url: `${baseURL}/login`,
          reuseExistingServer: false,
          timeout: 120_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
});
