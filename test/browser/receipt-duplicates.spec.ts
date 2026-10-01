import type { Page } from '@playwright/test';
import { z } from 'zod';
import {
  receiptDuplicatePairSchema,
  resolveReceiptPairSchema,
  type ReceiptReviewDto,
} from '../../src/shared/contracts/receipt-duplicates';
import { test, expect, screenshot, settle } from './fixtures';
import { VISUAL_IDS, VISUAL_NOW } from './constants';

const SECOND = '40000000-0000-4000-8000-000000000002';
const ROOT = '/api/receipts/duplicates';

// Isolate review decisions per browser while the rest of the archive uses the real fixture API.
async function reviewFixture(page: Page, longItems = false) {
  const response = await page.request.get(
    `${ROOT}/compare?firstId=${VISUAL_IDS.receipt}&secondId=${SECOND}`,
  );
  const actual = z.object({ data: receiptDuplicatePairSchema }).parse(await response.json()).data;
  const pair = receiptDuplicatePairSchema.parse({
    ...actual,
    kind: 'parts',
    reasons: ['date', 'total', 'merchant', 'time', 'card'],
    conflicts: ['number'],
    first: {
      ...actual.first,
      extracted: {
        ...actual.first.extracted,
        values: {
          ...actual.first.extracted?.values,
          purchasedTime: '17:42',
          receiptNumber: '2026-0923',
          card: '**** 1234',
          vendorTaxId: '987654321',
          paymentMethod: 'Card',
          taxAmount: { amount: 4.13, currency: 'EUR' },
          vendorAddress: '12 Riverside Avenue',
          city: 'Belgrade',
          country: 'RS',
          statementDescriptor: 'RIVERSIDE MARKET',
          ...(longItems
            ? {
                items: Array.from({ length: 60 }, (_, index) => ({
                  name: `Grocery item ${index + 1}`,
                  quantity: 2,
                  amount: 4.8,
                })),
              }
            : {}),
        },
      },
    },
    second: {
      ...actual.second,
      fileName: 'bank-terminal.jpg',
      extracted: {
        ...actual.second.extracted,
        values: {
          vendor: 'Riverside Market',
          purchasedAt: '2026-09-23',
          purchasedTime: '17:43',
          total: { amount: 24.8, currency: 'EUR' },
          card: '**** 1234',
          receiptNumber: 'POS-8130',
        },
      },
    },
  });
  let decision: ReceiptReviewDto | null = null;
  await page.route('**/api/receipts/duplicates', (route) =>
    route.fulfill({
      json: {
        data: {
          items: decision === null || decision.undoneAt !== null ? [pair] : [],
          nextCursor: longItems ? 'more' : null,
          checkedPairs: 1,
        },
      },
    }),
  );
  await page.route('**/api/receipts/duplicates?*', (route) =>
    route.fulfill({
      json: {
        data: {
          items: decision === null || decision.undoneAt !== null ? [pair] : [],
          nextCursor: longItems ? 'more' : null,
          checkedPairs: 1,
        },
      },
    }),
  );
  await page.route('**/api/receipts/duplicates/resolve', async (route) => {
    const input = resolveReceiptPairSchema.parse(route.request().postDataJSON());
    expect(input.revision).toBe(pair.revision);
    decision = {
      id: input.operationId,
      action: input.action,
      reverse: input.reverse,
      pair,
      resultId: input.action === 'DISMISS' ? null : pair.first.id,
      createdAt: VISUAL_NOW,
      undoneAt: null,
      actor: pair.first.owner,
    };
    await route.fulfill({ json: { data: decision } });
  });
  await page.route('**/api/receipts/duplicates/history*', (route) =>
    route.fulfill({
      json: { data: { items: decision === null ? [] : [decision], nextCursor: null } },
    }),
  );
  await page.route('**/api/receipts/duplicates/history/*/undo', async (route) => {
    if (decision === null) throw new Error('Nothing to undo');
    decision = { ...decision, undoneAt: VISUAL_NOW };
    await route.fulfill({ json: { data: decision } });
  });
  await page.route(`http://in-memory-storage.test/**${SECOND}/**`, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="640"><rect width="420" height="640" fill="#fffdf7"/><g fill="#30392f" font-family="monospace" font-size="18" text-anchor="middle"><text x="210" y="80">RIVERSIDE MARKET</text><text x="210" y="140">CARD PAYMENT</text><text x="210" y="205">23 Sep 2026 · 17:43</text><text x="210" y="270">**** **** **** 1234</text><text x="210" y="345" font-size="26">EUR 24.80</text><text x="210" y="420">APPROVED · POS-8130</text><text x="210" y="510">CUSTOMER COPY</text></g></svg>`,
    }),
  );
}

test('receipt duplicates compare originals, confirm merge, and undo through history', async ({
  page,
}, testInfo) => {
  await reviewFixture(page);
  await page.goto('/receipts');
  await expect(
    page.getByText('Riverside Market', { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
  await settle(page);
  await page.getByRole('link', { name: 'Find duplicates' }).click();
  await expect(page).toHaveURL(/\/receipts\/duplicates$/);
  await expect(page.getByRole('heading', { name: 'Possibly parts of one purchase' })).toBeVisible();
  for (const preview of await page
    .locator('.receipt-comparison-preview')
    .filter({ visible: true })
    .all()) {
    const image = preview.locator('img');
    await expect(image).toBeVisible();
    await expect(image).toHaveCSS('object-fit', 'contain');
    const box = await image.boundingBox();
    expect(box?.height).toBeGreaterThan(100);
  }
  await screenshot(page, 'receipt-duplicates', testInfo);
  await page.getByRole('radio', { name: 'Receipt 2, then receipt 1' }).check();
  await page.getByRole('button', { name: 'Combine into one PDF', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Receipt 2, then receipt 1')).toBeVisible();
  await screenshot(page, 'receipt-duplicates-confirm', testInfo);
  await dialog.getByRole('button', { name: 'Confirm decision' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Decision saved')).toBeVisible();
  await page.getByRole('tab', { name: 'Decision history' }).click();
  await expect(page.getByRole('button', { name: 'Undo decision', exact: true })).toBeVisible();
  await screenshot(page, 'receipt-duplicates-history', testInfo);
  await page.getByRole('button', { name: 'Undo decision', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Undo decision', exact: true })
    .click();
  await expect(page.getByText('Undone', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'To review' }).click();
  await expect(page.getByRole('heading', { name: 'Possibly parts of one purchase' })).toBeVisible();
});

test('receipt duplicates support manual shelf selection and Russian review', async ({
  page,
  context,
}, testInfo) => {
  await page.goto('/receipts?compare=1');
  for (const name of ['receipt-1.jpg', 'receipt-2.jpg']) {
    await page
      .getByRole('checkbox', { name: `Select ${name}`, exact: true })
      .filter({ visible: true })
      .check();
  }
  await screenshot(page, 'receipt-duplicates-selection', testInfo);
  await page.getByRole('button', { name: 'Compare selected' }).click();
  await expect(page).toHaveURL(/\/receipts\/duplicates\?firstId=/);
  await expect(page.getByRole('heading', { name: 'Manual comparison' })).toBeVisible();
  await reviewFixture(page);
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'ru', url: 'http://127.0.0.1:3012' }]);
  await page.goto('/receipts/duplicates');
  await settle(page);
  await expect(page.getByRole('heading', { name: 'Возможно, части одной покупки' })).toBeVisible();
  await expect(page.locator('.receipt-item-summary')).toBeInViewport({ ratio: 1 });
  for (const items of await page.locator('.receipt-items-scroll').all()) {
    await expect(items).toBeInViewport({ ratio: 1 });
    expect((await items.boundingBox())?.height).toBeGreaterThanOrEqual(48);
  }
  await expect(
    page.getByRole('button', { name: 'Объединить в один PDF', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await screenshot(page, 'receipt-duplicates-ru', testInfo);
});

test('receipt duplicates load empty discovery and history through the real API', async ({
  page,
}) => {
  await page.goto('/receipts');
  await expect(
    page.getByText('Riverside Market', { exact: true }).filter({ visible: true }).first(),
  ).toBeVisible();
  await settle(page);
  await page.getByRole('link', { name: 'Find duplicates' }).click();
  await expect(
    page.getByText(
      'No unreviewed matches found. For missing or incorrect data, choose two receipts manually.',
    ),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Decision history' }).click();
  await expect(page.getByText('No decisions yet.')).toBeVisible();
  await expect(page.locator('#main-content .ant-alert-error')).toHaveCount(0);
});

test('receipt review fits short windows with all facts and decisions visible', async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    !testInfo.project.name.includes('1440'),
    'Short-window acceptance runs in both desktop theme projects.',
  );
  await reviewFixture(page, true);
  for (const language of ['en', 'ru']) {
    await context.addCookies([
      { name: 'NEXT_LOCALE', value: language, url: 'http://127.0.0.1:3012' },
    ]);
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/receipts/duplicates');
      await expect(
        page.getByRole('heading', {
          name:
            language === 'en' ? 'Possibly parts of one purchase' : 'Возможно, части одной покупки',
        }),
      ).toBeVisible();
      await settle(page);
      expect(
        await page.evaluate(() => ({
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
        })),
      ).toEqual({ height: viewport.height, width: viewport.width });
      const facts = page.locator('.receipt-facts-scroll');
      expect(
        await facts.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
      ).toBe(true);
      for (const field of [
        'total',
        'purchasedAt',
        'purchasedTime',
        'receiptNumber',
        'vendorTaxId',
        'card',
        'paymentMethod',
        'taxAmount',
        'statementDescriptor',
        'vendorAddress',
        'city',
        'country',
      ]) {
        await expect(page.locator(`[data-fact="${field}"]`)).toBeInViewport({ ratio: 1 });
      }
      for (const name of language === 'en'
        ? ['Keep receipt 1', 'Keep receipt 2', 'Different purchases', 'Combine into one PDF']
        : ['Оставить чек 1', 'Оставить чек 2', 'Разные покупки', 'Объединить в один PDF']) {
        await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
      }
      const items = page.getByRole('region', {
        name: language === 'en' ? 'Items in receipt 1' : 'Позиции чека 1',
      });
      expect(await items.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
        true,
      );
      await items.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(page.getByText('Grocery item 60 × 2')).toBeVisible();
      await screenshot(page, `receipt-duplicates-short-${viewport.width}-${language}`, testInfo);
    }
  }
  await context.addCookies([{ name: 'NEXT_LOCALE', value: 'en', url: 'http://127.0.0.1:3012' }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/receipts/duplicates');
  await expect(page.getByRole('button', { name: 'Originals', exact: true })).toBeVisible();
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(844);
  await expect(
    page.getByRole('button', { name: 'Combine into one PDF', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await page.getByRole('button', { name: 'Originals', exact: true }).click();
  await expect(page.getByRole('dialog').locator('img')).toHaveCount(2);
  await screenshot(page, 'receipt-duplicates-originals-mobile', testInfo);
});
