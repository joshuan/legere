import { mkdir } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { validateTestDatabaseUrls } from '../helpers/database-url';
import { VISUAL_EMAIL, VISUAL_IDS, VISUAL_NOW, VISUAL_PASSWORD } from './constants';

test('sign in through the real password form', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(VISUAL_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(VISUAL_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(
    page.getByText('Riverside apartment rental agreement', { exact: true }),
  ).toBeVisible();
  if (process.env.DATABASE_URL) {
    validateTestDatabaseUrls();
    const prisma = new PrismaClient();
    try {
      // The real login creates its session with a database default timestamp. Freeze only that
      // presentation field after authentication so the devices table does not drift each run.
      await prisma.session.updateMany({
        where: { userId: VISUAL_IDS.user },
        data: { createdAt: new Date(VISUAL_NOW) },
      });
    } finally {
      await prisma.$disconnect();
    }
  }
  await mkdir('test-results/auth', { recursive: true });
  await page.context().storageState({ path: 'test-results/auth/admin.json' });
});
