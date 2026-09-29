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
    if (name === 'processing-services') {
      // Opening this tab checks services automatically. Compare the settled table after its
      // temporary completion message expires, not whichever side of the two-second timer won.
      await expect(page.getByText('Service checks completed', { exact: true })).toBeHidden();
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
    const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page.locator('a[href="/search"]').filter({ visible: true }).first().click();
    await expect(page).toHaveURL(/\/search$/);
    await expect(
      page.getByText('Riverside apartment rental agreement', { exact: true }),
    ).toBeVisible();
    await settle(page);
    await expectResponsive(page);
    if (await menu.isVisible()) await menu.click();
    await page
      .getByRole('link', { name: 'Documents', exact: true })
      .filter({ visible: true })
      .click();
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

test('toolbar disclosures preserve filters and return keyboard focus', async ({
  page,
}, testInfo) => {
  await page.goto('/documents?origin=MANAGED');
  await settle(page);
  const filters = page.getByRole('button', { name: /^Filters/ });
  await filters.click();
  const panel = page.getByRole('group', { name: 'Filters', exact: true });
  await expect(panel.getByRole('combobox', { name: 'Origin', exact: true })).toBeVisible();
  await screenshot(page, 'document-filters', testInfo);
  await panel.getByRole('button', { name: 'Clear filters' }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(page).toHaveURL(/origin=MANAGED/);
  const view = page.getByRole('button', { name: 'View', exact: true });
  await view.click();
  await expect(page.getByRole('group', { name: 'View', exact: true })).toBeVisible();
  await screenshot(page, 'document-view-controls', testInfo);
  await view.press('Escape');
  await expect(view).toBeFocused();
});

test('document editing keeps fields and cancellation available', async ({ page }, testInfo) => {
  await page.goto(`/documents/${VISUAL_IDS.document}/details`);
  await settle(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await screenshot(page, 'document-editing', testInfo);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
});

test('library drawer keeps its footer inside the viewport', async ({ page }, testInfo) => {
  await page.goto('/admin/libraries');
  await settle(page);
  await page.getByRole('button', { name: /Add library/ }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await settle(page);
  const save = drawer.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeInViewport();
  await screenshot(page, 'library-form', testInfo);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('mobile navigation closes with Escape and after choosing a screen', async ({
  page,
}, testInfo) => {
  test.skip((testInfo.project.use.viewport?.width ?? 1440) >= 768, 'drawer is a phone layout');
  await page.goto('/documents');
  await settle(page);
  const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
  await expect(drawer).toBeVisible();
  await screenshot(page, 'mobile-navigation', testInfo);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await drawer.getByRole('link', { name: 'Receipts', exact: true }).click();
  await expect(page).toHaveURL(/\/receipts$/);
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Receipts', exact: true })).toBeVisible();
});

test('Russian headings, navigation and filters fit the same layout', async ({ page }, testInfo) => {
  await page.context().addCookies([
    {
      name: 'NEXT_LOCALE',
      value: 'ru',
      url: testInfo.project.use.baseURL ?? 'http://127.0.0.1:3012',
    },
  ]);
  await page.goto('/documents');
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Документы', exact: true })).toBeVisible();
  await screenshot(page, 'documents-ru', testInfo);
  await page.getByRole('button', { name: 'Фильтры', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Фильтры', exact: true })).toBeVisible();
  await screenshot(page, 'document-filters-ru', testInfo);
});

test('long document text scrolls inside its pane while tabs stay visible', async ({
  page,
}, testInfo) => {
  test.skip(
    (testInfo.project.use.viewport?.width ?? 1440) < 992,
    'phones use ordinary page scrolling',
  );
  await page.route(`**/api/documents/${VISUAL_IDS.document}/markdown`, (route) =>
    route.fulfill({
      json: {
        data: {
          markdown: Array.from(
            { length: 80 },
            (_, i) =>
              `## Section ${i + 1}\n\nA synthetic paragraph for verifying independent document scrolling.`,
          ).join('\n\n'),
        },
      },
    }),
  );
  await page.goto(`/documents/${VISUAL_IDS.document}/text`);
  await settle(page);
  const pane = page.getByRole('tabpanel', { name: 'Text', exact: true });
  await pane.hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  await expect(page.getByRole('tab', { name: 'Text', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(
    (testInfo.project.use.viewport?.height ?? 960) + 1,
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('receipt date range picker stays within the viewport', async ({ page }, testInfo) => {
  await page.goto('/receipts');
  await settle(page);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await page.getByPlaceholder('Purchased from', { exact: true }).click();
  await expect(page.locator('.ant-picker-dropdown')).toBeVisible();
  await screenshot(page, 'receipt-date-filter', testInfo);
  const bounds = await page.locator('.ant-picker-panel-container').boundingBox();
  expect(bounds).not.toBeNull();
  if (bounds !== null) {
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      (testInfo.project.use.viewport?.width ?? 1440) + 1,
    );
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('.ant-picker-dropdown')).toBeHidden();
});
