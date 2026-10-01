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
async function reviewFixture(page: Page) {
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
          nextCursor: null,
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
          nextCursor: null,
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
  for (const preview of await page.locator('.receipt-comparison-preview').all()) {
    const image = preview.locator('img');
    await expect(image).toBeVisible();
    await expect(image).toHaveCSS('object-fit', 'contain');
    expect((await image.boundingBox())?.height).toBeLessThanOrEqual(320);
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
