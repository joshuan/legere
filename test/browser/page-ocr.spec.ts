import type { OcrResult, OcrRunDto, OcrRunsResponse } from '../../src/shared/contracts/page-ocr';
import {
  test,
  expect,
  screenshot,
  settle,
  settleTabNavigation,
  expectResponsive,
} from './fixtures';
import { VISUAL_IDS, VISUAL_NOW } from './constants';

const pageId = 'd0000000-0000-4000-8000-000000000001';
const runId = 'e0000000-0000-4000-8000-000000000001';
const oldId = 'e0000000-0000-4000-8000-000000000002';
const googleId = 'f0000000-0000-4000-8000-000000000001';
const yandexId = 'f0000000-0000-4000-8000-000000000002';
const image = `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792"><rect width="612" height="792" fill="white"/><g font-family="Arial" fill="#21372e"><text x="70" y="112" font-size="26">HOUSEHOLD RECORD</text><text x="70" y="153" font-size="18">Riverside apartment</text></g><path d="M70 182H542M70 222H510M70 244H538M70 266H485" stroke="#b9c1b7" stroke-width="6"/></svg>`;
const polygon = (x: number, y: number, width: number, height: number) => [
  { x: x / 612, y: y / 792 },
  { x: (x + width) / 612, y: y / 792 },
  { x: (x + width) / 612, y: (y + height) / 792 },
  { x: x / 612, y: (y + height) / 792 },
];
const result: OcrResult = {
  schemaVersion: 1,
  pageId,
  imageHash: 'test-raster',
  width: 612,
  height: 792,
  provider: 'google-document-ai',
  model: 'pretrained-ocr-v2.1',
  fullText: 'HOUSEHOLD RECORD\nRiverside apartment',
  elements: [
    {
      id: 'line-0',
      parentId: null,
      level: 'line',
      order: 0,
      text: 'HOUSEHOLD RECORD',
      polygon: polygon(70, 86, 302, 30),
      confidence: 0.97,
    },
    {
      id: 'line-1',
      parentId: null,
      level: 'line',
      order: 1,
      text: 'Riverside apartment',
      polygon: polygon(70, 136, 161, 21),
      confidence: 0.88,
    },
    {
      id: 'word-0',
      parentId: 'line-0',
      level: 'word',
      order: 0,
      text: 'HOUSEHOLD',
      polygon: polygon(70, 86, 167, 30),
      confidence: 0.99,
    },
  ],
};
const run: OcrRunDto = {
  id: runId,
  createdAt: VISUAL_NOW,
  stale: false,
  pages: [
    {
      id: googleId,
      pageId,
      pageNumber: 1,
      provider: 'google-document-ai',
      model: result.model,
      status: 'DONE',
      attempts: 1,
      submittedAttempts: 1,
      cached: false,
      error: null,
      durationMs: 1200,
      hasImage: true,
      hasRaw: true,
      completedAt: VISUAL_NOW,
    },
    {
      id: yandexId,
      pageId,
      pageNumber: 1,
      provider: 'yandex-vision',
      model: 'page',
      status: 'DONE',
      attempts: 1,
      submittedAttempts: 1,
      cached: false,
      error: null,
      durationMs: 800,
      hasImage: true,
      hasRaw: true,
      completedAt: VISUAL_NOW,
    },
  ],
};

test('page OCR: overlays, linked selection, provider comparison and saved revisions', async ({
  page,
}, info) => {
  const runs: OcrRunsResponse = {
    pages: [{ id: pageId, number: 1 }],
    providers: [
      { id: 'google-document-ai', configured: true, model: result.model },
      { id: 'yandex-vision', configured: true, model: 'page' },
    ],
    runs: [run, { ...run, id: oldId, stale: true, createdAt: '2026-09-24T12:00:00.000Z' }],
  };
  await page.route(`**/api/documents/${VISUAL_IDS.document}/ocr-runs`, (route) =>
    route.fulfill({ json: { data: runs } }),
  );
  await page.route(`**/api/documents/${VISUAL_IDS.document}/ocr-results/*`, (route) =>
    route.fulfill({
      json: {
        data: {
          ...result,
          ...(route.request().url().endsWith(yandexId)
            ? {
                provider: 'yandex-vision',
                model: 'page',
                elements: result.elements.map((element) => ({ ...element, confidence: null })),
              }
            : {}),
        },
      },
    }),
  );
  await page.route(`**/api/documents/${VISUAL_IDS.document}/ocr-results/*/image`, (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: image }),
  );
  await page.goto(`/documents/${VISUAL_IDS.document}/ocr`);
  await settle(page);
  await settleTabNavigation(page);
  await expect(page.locator('svg [role="button"]')).toHaveCount(2);
  const title = page.locator('svg').getByRole('button', { name: 'HOUSEHOLD RECORD', exact: true });
  await title.click();
  await expect(title).toHaveAttribute('aria-pressed', 'true');
  await screenshot(page, 'document-ocr', info);
  await page.getByText('Text overlay', { exact: true }).click();
  await expect(page.locator('svg g text')).toHaveCount(2);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.getByRole('button', { name: '125%', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Recognition provider', exact: true }).click();
  await page.getByTitle('Yandex Vision', { exact: true }).last().click();
  await expect(page.getByRole('button', { name: '125%', exact: true })).toBeVisible();
  await expect(page.getByText('97%', { exact: true })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Recognition detail', exact: true }).click();
  await page.getByTitle('Words', { exact: true }).click();
  await expect(page.locator('svg [role="button"]')).toHaveCount(1);
  const width = info.project.use.viewport?.width ?? 1440;
  if (width < 768) {
    await page.getByRole('button', { name: 'Recognized text', exact: true }).click();
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'HOUSEHOLD', exact: true }).click();
    await expect(drawer.getByRole('button', { name: 'HOUSEHOLD', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await screenshot(page, 'document-ocr-mobile-text', info);
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  } else {
    await page
      .getByRole('button', { name: 'HOUSEHOLD', exact: true })
      .filter({ visible: true })
      .last()
      .click();
    await expect(page.locator('svg [role="button"]')).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByRole('combobox', { name: 'Recognition history', exact: true }).click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'previous version' }).click();
  await expect(
    page.getByText(
      'This result belongs to a previous document version. The saved input image is shown.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByText('New recognition', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recognize page', exact: true })).toBeDisabled();
  await expectResponsive(page);
});

test('page OCR: prepares legacy pages locally without submitting cloud work', async ({ page }) => {
  const submitted: unknown[] = [];
  await page.route(`**/api/documents/${VISUAL_IDS.document}/ocr-runs`, (route) =>
    route.fulfill({ json: { data: { pages: [], providers: [], runs: [] } } }),
  );
  await page.route(`**/api/documents/${VISUAL_IDS.document}/reprocess`, (route) => {
    submitted.push(route.request().postDataJSON());
    return route.fulfill({
      json: { data: { documentId: VISUAL_IDS.document, steps: ['canonical'] } },
    });
  });
  await page.goto(`/documents/${VISUAL_IDS.document}/ocr`);
  await expect(page.getByRole('button', { name: 'Recognize page', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare pages', exact: true }).click();
  await expect.poll(() => submitted).toEqual([{ steps: ['canonical'] }]);
});
