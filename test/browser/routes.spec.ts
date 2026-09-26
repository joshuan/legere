import {
  test,
  expect,
  screenshot,
  settle,
  settleTabNavigation,
  settlePdfPreview,
  expectResponsive,
} from './fixtures';
import { VISUAL_IDS, VISUAL_RECEIPT_SOURCE } from './constants';

const routes = [
  ['documents', '/documents', 'Riverside apartment rental agreement'],
  ['receipts', '/receipts', 'Riverside Market'],
  ['receipt', `/receipts/${VISUAL_IDS.receipt}`, 'Riverside Market'],
  ['document-preview', `/documents/${VISUAL_IDS.document}`, 'Riverside apartment rental agreement'],
  ['document-text', `/documents/${VISUAL_IDS.document}/text`, 'Rental agreement'],
  [
    'document-details',
    `/documents/${VISUAL_IDS.document}/details`,
    'Riverside apartment rental agreement',
  ],
  ['document-files', `/documents/${VISUAL_IDS.document}/files`, 'household-record-1.pdf'],
  [
    'document-related',
    `/documents/${VISUAL_IDS.document}/related`,
    'Riverside apartment rental agreement',
  ],
  ['document-log', `/documents/${VISUAL_IDS.document}/log`, 'Riverside apartment rental agreement'],
  ['search', '/search', 'Riverside apartment rental agreement'],
  ['search-results', '/search?q=Riverside', 'Riverside apartment rental agreement'],
  ['collections', '/collections', 'Moving to Riverside'],
  ['collection', `/collections/${VISUAL_IDS.collection}`, 'Moving to Riverside'],
  ['people', '/people', 'Alex Morgan'],
  ['subjects', '/subjects', 'Riverside apartment'],
  ['subject-kinds', '/subject-kinds', 'Apartment'],
  ['document-types', '/document-types', 'Contract'],
  ['browse-library', `/browse/${VISUAL_IDS.library}`, 'Family archive'],
  ['browse-types', '/browse/types', 'Contract'],
  ['browse-people', '/browse/people', 'Alex Morgan'],
  ['browse-subjects', '/browse/subjects', 'Apartment'],
  ['browse-years', '/browse/years', '2026'],
  ['admin-libraries', '/admin/libraries', 'Family archive'],
  ['admin-library', `/admin/libraries/${VISUAL_IDS.library}`, 'Family archive'],
  ['admin-users', '/admin/users', 'Sam Rivera'],
  ['processing', '/admin/processing', 'Processing'],
  ['processing-services', '/admin/processing/services', 'Processing'],
  ['processing-pipeline', '/admin/processing/pipeline', 'Processing'],
  ['processing-failures', '/admin/processing/failures', 'Processing'],
  ['processing-receipts', '/admin/processing/receipts', 'Processing'],
  ['admin-trash', '/admin/trash', 'Superseded household scan.pdf'],
  ['admin-instance', '/admin/instance', 'Instance'],
  ['settings', '/settings', 'Signed-in devices'],
] as const;

for (const [name, path, content] of routes) {
  test(`${name}: populated route`, async ({ page }, testInfo) => {
    await page.goto(path);
    await expect(page.locator('#main-content')).toBeVisible();
    await expect(
      page
        .locator('#main-content')
        .getByText(content, { exact: false })
        .filter({ visible: true })
        .first(),
    ).toBeVisible();
    await settle(page);
    await settleTabNavigation(page);
    if (['documents', 'search', 'search-results', 'collection'].includes(name)) {
      await expect(
        page.locator('img[src*="/api/documents/"][src*="/thumb"]').first(),
      ).toBeVisible();
    }
    if (name === 'document-preview') {
      await expect(page.locator('object[type="application/pdf"]')).toBeVisible();
      await expect(page.locator('img[src*="/api/documents/"][src*="/preview"]')).toBeVisible();
      await settlePdfPreview(page);
    }
    if (name === 'document-files') {
      const title = page
        .getByText('household-record-1.pdf', { exact: true })
        .filter({ visible: true });
      // Zero page overflow alone can still hide text compressed to a single-letter column.
      expect((await title.boundingBox())?.width).toBeGreaterThanOrEqual(100);
    }
    await screenshot(page, name, testInfo);
  });
}

// These routes reuse the same document-grid presentation. Exercise their server-side name
// resolution and responsive behavior without committing another copy of the same grid baseline.
for (const path of [
  `/browse/types/${VISUAL_IDS.type}`,
  `/browse/people/${VISUAL_IDS.person}`,
  `/browse/subjects/${VISUAL_IDS.kind}`,
  `/browse/subjects/${VISUAL_IDS.kind}/${VISUAL_IDS.subject}`,
  '/browse/years/2026',
  '/admin/queue',
]) {
  test(`resolved route ${path}`, async ({ page }) => {
    await page.goto(path);
    if (path === '/admin/queue') await expect(page).toHaveURL(/\/admin\/processing$/);
    await expect(page.locator('#main-content')).toBeVisible();
    await settle(page);
    await expectResponsive(page);
    await expect(page.locator('#main-content')).not.toContainText('Page not found');
  });
}

test('documents and search retain their own query data during client navigation', async ({
  page,
}) => {
  await page.goto('/documents');
  for (let round = 0; round < 3; round += 1) {
    await expect(
      page.getByText('Riverside apartment rental agreement', { exact: true }),
    ).toBeVisible();
    await page.locator('a[href="/search"]').first().click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      page.getByText('Riverside apartment rental agreement', { exact: true }),
    ).toBeVisible();
    await settle(page);
    await expectResponsive(page);
    await page.locator('a[href="/documents"]').first().click();
    await expect(page).toHaveURL(/\/documents$/);
    await settle(page);
  }
});

test('keyboard skip link focuses the main content', async ({ page }) => {
  await page.goto('/documents');
  await settle(page);
  await page.keyboard.press('Tab');
  const skip = page.locator('a[href="#main-content"]');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('a receipt opens its source details without leaving the route', async ({ page }, testInfo) => {
  await page.goto(`/receipts/${VISUAL_IDS.receipt}`);
  await settle(page);
  const details = page.getByRole('button', { name: /Source text/ });
  await expect(details).toBeVisible();
  await details.click();
  await expect(page.getByText(VISUAL_RECEIPT_SOURCE, { exact: true })).toBeVisible();
  await screenshot(page, 'receipt-source-expanded', testInfo);
  await expect(page).toHaveURL(new RegExp(`/receipts/${VISUAL_IDS.receipt}$`));
});

test('collection sharing dialog stays usable and can be cancelled', async ({ page }, testInfo) => {
  await page.goto(`/collections/${VISUAL_IDS.collection}`);
  await settle(page);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await screenshot(page, 'collection-share-dialog', testInfo);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/collections/${VISUAL_IDS.collection}$`));
});

test('document page arrangement and crop remain available on touch widths', async ({
  page,
}, testInfo) => {
  await page.goto(`/documents/${VISUAL_IDS.document}/files`);
  await settle(page);
  const firstPage = page.getByRole('button', { name: /^Page 1 of 2/ });
  await expect(firstPage).toBeVisible();
  await firstPage.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await screenshot(page, 'document-page-arrangement', testInfo);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const crop = page.getByRole('button', { name: 'Crop page 1', exact: true });
  if (testInfo.project.use.hasTouch) await crop.tap();
  else await crop.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await screenshot(page, 'document-page-crop', testInfo);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
