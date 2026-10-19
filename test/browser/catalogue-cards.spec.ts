import sharp from 'sharp';
import { z } from 'zod';
import type { Locator } from '@playwright/test';
import {
  catalogueIconSchema,
  type CatalogueIcon,
} from '../../src/shared/contracts/catalogue-icons';
import { listSubjectsResponseSchema } from '../../src/shared/contracts/subjects';
import { test, expect, screenshot, settle } from './fixtures';
import { VISUAL_IDS } from './constants';

async function expectReadable(locator: Locator): Promise<void> {
  const ratio = await locator.evaluate((element) => {
    const luminance = (color: string): number => {
      const [red = 0, green = 0, blue = 0] = (color.match(/[\d.]+/g) ?? [])
        .slice(0, 3)
        .map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    let surface: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (surface !== null && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(surface).backgroundColor;
      surface = surface.parentElement;
    }
    const text = luminance(getComputedStyle(element).color);
    const fill = luminance(background);
    return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

test('object cards: sorting, built-in icons and uploaded logos', async ({ page }, info) => {
  const path = `/browse/subjects/${VISUAL_IDS.kind}`;
  await page.goto(path);
  await expect(page.getByRole('link', { name: 'Riverside apartment', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort objects' })).toBeVisible();
  await expect(page.getByText('4 documents', { exact: true })).toBeVisible();
  await screenshot(page, 'browse-subject-cards', info);
  await page.getByRole('combobox', { name: 'Sort objects' }).click();
  await page.getByTitle('Name: A–Z', { exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/sort=name&order=asc/);

  // Each browser keeps its appearance changes local; parallel viewport tests share read fixtures.
  // The HTTP suite covers genuine image conversion, persistence, cleanup and authorization.
  let icon: CatalogueIcon | null = null;
  const logo = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="160"><rect width="360" height="160" fill="white"/><path d="M40 110V65L80 35l40 30v45H90V80H70v30z" fill="#805000"/><text x="145" y="94" font-family="sans-serif" font-size="30" fill="#14212d">Riverside</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  await page.route(/\/api\/subjects\?/, async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    const parsed = z.object({ data: listSubjectsResponseSchema }).parse(body);
    parsed.data.items = parsed.data.items.map((item) =>
      item.id === VISUAL_IDS.subject ? { ...item, icon } : item,
    );
    await route.fulfill({ json: parsed });
  });
  await page.route(`**/api/admin/catalogue-icons/subjects/${VISUAL_IDS.subject}`, async (route) => {
    const body: unknown = route.request().postDataJSON();
    const { symbol } = z.object({ symbol: z.enum(['bank']).nullable() }).parse(body);
    icon = symbol === null ? null : { type: 'symbol', symbol };
    await route.fulfill({ json: { data: { icon } } });
  });
  await page.route(
    `**/api/admin/catalogue-icons/subjects/${VISUAL_IDS.subject}/image`,
    async (route) => {
      expect(route.request().postDataBuffer()?.length).toBeGreaterThan(0);
      icon = catalogueIconSchema.parse({
        type: 'image',
        revision: 'a0000000-0000-4000-8000-000000000091',
      });
      await route.fulfill({ status: 201, json: { data: { icon } } });
    },
  );
  await page.route(
    `**/api/catalogue-icons/subjects/${VISUAL_IDS.subject}/image?*`,
    async (route) => {
      await route.fulfill({ contentType: 'image/png', body: logo });
    },
  );

  await page.getByRole('button', { name: 'Change icon for Riverside apartment' }).click();
  await page.getByRole('radio', { name: 'Bank', exact: true }).click();
  await screenshot(page, 'catalogue-icon-editor', info);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Icon saved', { exact: true })).toBeHidden();
  await expect(page.locator('.legere-catalogue-cover .anticon-bank')).toBeVisible();

  await page.getByRole('button', { name: 'Change icon for Riverside apartment' }).click();
  await page
    .getByRole('dialog')
    .locator('input[type=file]')
    .setInputFiles({ name: 'riverside.png', mimeType: 'image/png', buffer: logo });
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText('Icon saved', { exact: true })).toBeHidden();
  await expect(page.locator('.legere-catalogue-cover img')).toBeVisible();
  await screenshot(page, 'catalogue-logo-card', info);
});

test('object documents: fixed scope survives sorting, clearing and grouping', async ({
  page,
}, info) => {
  const seen: URLSearchParams[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/documents' || url.pathname === '/api/documents/groups')
      seen.push(url.searchParams);
  });
  const path = `/browse/subjects/${VISUAL_IDS.kind}/${VISUAL_IDS.subject}`;
  await page.goto(`${path}?subjectId=${VISUAL_IDS.person}&origin=MANAGED&sort=documentDate`);
  await expect(
    page.getByRole('heading', { name: 'Riverside apartment', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTitle('Documents about Riverside apartment — fixed filter').filter({ visible: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page).toHaveURL(`${path}?sort=documentDate`);
  await expect(
    page.getByText('Riverside apartment rental agreement', { exact: true }),
  ).toBeVisible();
  await settle(page);
  await expectReadable(page.locator('.ant-breadcrumb a').filter({ visible: true }).first());
  await expectReadable(page.getByRole('combobox', { name: 'Order', exact: true }).locator('..'));
  await screenshot(page, 'browse-subject-documents', info);
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('combobox', { name: 'Group by', exact: true }).click();
  await page.getByTitle('Year', { exact: true }).filter({ visible: true }).click();
  await expect(page).toHaveURL(/groupBy=year/);
  await settle(page);
  expect(seen.length).toBeGreaterThanOrEqual(3);
  expect(seen.every((params) => params.get('subjectId') === VISUAL_IDS.subject)).toBe(true);
});
