import { test, expect, screenshot } from './fixtures';

test.describe('public forms and validation', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('login', async ({ page }, testInfo) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await screenshot(page, 'login', testInfo);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Enter your email', { exact: false })).toBeVisible();
    await screenshot(page, 'login-validation', testInfo);
  });

  test('onboarding form', async ({ page }, testInfo) => {
    // This browser-only read fixture presents the first-install screen. Registration mutations
    // still go to the real authenticated backend, and no account or session is forged.
    await page.route('**/api/auth/onboarding', (route) =>
      route.fulfill({ json: { data: { required: true } } }),
    );
    await page.goto('/onboarding');
    await expect(page.getByRole('textbox', { name: 'Email', exact: true })).toBeVisible();
    await screenshot(page, 'onboarding', testInfo);
  });

  for (const route of ['invite', 'reset']) {
    test(`${route} invalid link`, async ({ page }, testInfo) => {
      await page.goto(`/${route}`);
      await expect(page.locator('.ant-result-warning')).toBeVisible();
      await screenshot(page, `${route}-invalid`, testInfo);
    });
  }
});

test('documents empty state', async ({ page }, testInfo) => {
  await page.route('**/api/documents?*', (route) =>
    route.fulfill({ json: { data: { items: [], nextCursor: null } } }),
  );
  await page.goto('/documents');
  await expect(page.locator('#main-content .ant-empty')).toBeVisible();
  await screenshot(page, 'documents-empty', testInfo);
});

test('documents recoverable API failure', async ({ page }, testInfo) => {
  await page.route('**/api/documents?*', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Temporarily unavailable', details: null },
      },
    }),
  );
  await page.goto('/documents');
  await expect(page.locator('#main-content').getByRole('alert')).toBeVisible();
  await screenshot(page, 'documents-error', testInfo);
});
