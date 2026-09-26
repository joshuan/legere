import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { pdfWithText } from '../fixtures/pdf';
import { VISUAL_NOW } from './constants';

const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="612" height="792" viewBox="0 0 612 792">
<rect width="612" height="792" fill="#fffdf7"/><rect x="44" y="44" width="524" height="704" rx="3" fill="none" stroke="#d6d0bd"/>
<text x="70" y="112" font-family="Arial,sans-serif" font-size="26" fill="#21372e">HOUSEHOLD RECORD</text>
<text x="70" y="153" font-family="Arial,sans-serif" font-size="18" fill="#506359">Riverside apartment</text>
<path d="M70 182H542M70 222H510M70 244H538M70 266H485M70 324H540M70 346H515M70 368H539M70 426H475M70 448H540M70 470H506" stroke="#b9c1b7" stroke-width="6"/>
<rect x="70" y="534" width="472" height="100" fill="#edf1e8"/><text x="92" y="574" font-family="Arial,sans-serif" font-size="16" fill="#385044">A clear archive for everyday life.</text>
<text x="92" y="605" font-family="Arial,sans-serif" font-size="14" fill="#506359">Belgrade · September 2026</text></svg>`;

function receiptPreview(path: string): string {
  const vendor =
    path.includes('40000000-0000-4000-8000-000000000002') || path.endsWith('/receipt-2.jpg')
      ? 'STATIONERY &amp; OFFICE SUPPLIES'
      : 'RIVERSIDE MARKET';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="640" viewBox="0 0 420 640">
<rect width="420" height="640" fill="#fffdf7"/><g fill="#30392f" font-family="monospace" font-size="16">
<text x="210" y="66" text-anchor="middle" font-size="18">${vendor}</text>
<text x="210" y="98" text-anchor="middle">12 Riverside Road · Belgrade</text>
<text x="36" y="151">23 September 2026</text><text x="36" y="185">Receipt #2026-0923</text>
<path d="M36 214H384M36 398H384" stroke="#7e877b" stroke-dasharray="5 4"/>
<text x="36" y="252">Whole grain bread</text><text x="36" y="282">2 × 3.40</text><text x="384" y="282" text-anchor="end">6.80</text>
<text x="36" y="326">Seasonal groceries</text><text x="36" y="356">1 × 18.00</text><text x="384" y="356" text-anchor="end">18.00</text>
<text x="36" y="443" font-size="21">TOTAL EUR</text><text x="384" y="443" text-anchor="end" font-size="21">24.80</text>
<text x="210" y="531" text-anchor="middle">Thank you for shopping with us.</text></g></svg>`;
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /hydration|hydrated|server rendered HTML|Minified React error #(418|419|421|422|423|425)/i.test(
          message.text(),
        )
      ) {
        errors.push(message.text());
      }
    });
    await page.clock.setFixedTime(new Date(VISUAL_NOW));
    await page.route('http://in-memory-storage.test/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const pdf = path.endsWith('.pdf');
      await route.fulfill({
        contentType: pdf ? 'application/pdf' : 'image/svg+xml',
        body: pdf
          ? pdfWithText(['Riverside apartment rental agreement', 'Terms and signatures'])
          : path.includes('/receipts/') || /\/fixtures\/receipt-[12]\.jpg$/.test(path)
            ? receiptPreview(path)
            : preview,
      });
    });
    // Browser routing does not intercept a redirected request a second time. Let the genuine
    // artifact endpoint authorize the request, then replace only its confirmed test-storage 302
    // with fixture bytes, rather than sending the browser to a nonexistent external bucket.
    await page.route(
      /\/api\/documents\/[^/]+\/(?:thumb|preview|canonical|files\/[^/]+\/(?:content|pages\/\d+\/thumb))(?:\?.*)?$/,
      async (route) => {
        const response = await route.fetch({ maxRedirects: 0 });
        const location = response.headers().location;
        if (response.status() === 302 && location?.startsWith('http://in-memory-storage.test/')) {
          const pdf = new URL(location).pathname.endsWith('.pdf');
          await route.fulfill({
            status: 200,
            contentType: pdf ? 'application/pdf' : 'image/svg+xml',
            body: pdf
              ? pdfWithText(['Riverside apartment rental agreement', 'Terms and signatures'])
              : preview,
          });
        } else {
          await route.fulfill({ response });
        }
      },
    );
    await use(page);
    expect(errors, 'uncaught browser exceptions').toEqual([]);
  },
});
export { expect };

export async function settle(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(page.locator('.ant-spin-spinning')).toHaveCount(0);
  await expect(
    page.locator(
      '.ant-select-arrow-loading:visible, .anticon-loading:visible, .ant-btn-loading:visible',
    ),
  ).toHaveCount(0);
  await page.evaluate(async () => {
    await document.fonts.ready;
    // Full-page screenshots must load images outside the initial viewport, including page-strip
    // thumbnails. Calling decode on an offscreen lazy image can otherwise wait forever.
    for (const image of document.images) image.loading = 'eager';
    await Promise.all(
      Array.from(document.images).map((image) => image.decode().catch(() => undefined)),
    );
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.images)
            .filter(
              (image) =>
                image.getClientRects().length > 0 && (!image.complete || image.naturalWidth === 0),
            )
            .map((image) => image.getAttribute('src')),
        ),
      { message: 'visible images must finish loading successfully' },
    )
    .toEqual([]);
  await expect(page.getByText('Something went wrong', { exact: true })).toHaveCount(0);
}

export async function expectResponsive(page: Page): Promise<void> {
  const overflow = () =>
    page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth <= width + 1) return [];
      return Array.from(document.body.querySelectorAll('*'))
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && (box.right > width + 1 || box.left < -1);
        })
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName,
          classes: element.className,
          text: element.textContent?.slice(0, 100),
        }));
    });
  await expect
    .poll(overflow, {
      message: 'page must not scroll horizontally; tables scroll inside their own container',
    })
    .toEqual([]);
}

export async function screenshot(page: Page, name: string, testInfo: TestInfo): Promise<void> {
  await settle(page);
  // Autofocus and focus-driven tab scrolling can leave a long route below its initial viewport.
  // A full-page capture otherwise paints sticky/fixed navigation at that old scroll position.
  await page.evaluate(async () => {
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expectResponsive(page);
  // Check the rendered token, not just the emulated media query: a missing theme provider used
  // to leave dark public forms surrounded by a white canvas despite prefers-color-scheme=dark.
  const channels = await page
    .locator('.ant-app')
    .evaluate((element) =>
      (getComputedStyle(element).backgroundColor.match(/\d+/g) ?? []).slice(0, 3).map(Number),
    );
  expect(channels).toHaveLength(3);
  const brightness = channels.reduce((sum, value) => sum + value, 0) / 3;
  if (testInfo.project.name.endsWith('-dark')) expect(brightness).toBeLessThan(70);
  else expect(brightness).toBeGreaterThan(200);
  if (process.env.BROWSER_CAPTURE_ONLY === '1') {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  } else {
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  }
}

export async function settleTabNavigation(page: Page): Promise<void> {
  for (const navigation of await page.locator('.ant-tabs-nav:visible').all()) {
    const selected = navigation.getByRole('tab', { selected: true });
    if ((await selected.count()) !== 1) continue;
    // rc-tabs preserves its earlier scroll offset when a selected tab already fits. The shell's
    // initial responsive collapse can therefore leave two valid offsets. Use the same real
    // keyboard-focus path every time, without changing the selected route or overriding CSS.
    await navigation.getByRole('tab').first().focus();
    await selected.focus();
    await expect
      .poll(async () => {
        const tab = await selected.boundingBox();
        const wrapper = await navigation.locator('.ant-tabs-nav-wrap').boundingBox();
        return Boolean(
          tab &&
          wrapper &&
          tab.x >= wrapper.x - 1 &&
          tab.x + tab.width <= wrapper.x + wrapper.width + 1,
        );
      })
      .toBe(true);
    await selected.blur();
  }
}

export async function settlePdfPreview(page: Page): Promise<void> {
  // The pinned Chromium build exposes its actual PDF viewer in an extension frame. The object
  // element being visible alone does not mean its PDF pages have finished loading.
  const viewerURL = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html';
  await expect.poll(() => page.frames().some((frame) => frame.url() === viewerURL)).toBe(true);
  const pdf = page.frames().find((frame) => frame.url() === viewerURL);
  if (pdf === undefined) throw new Error('The PDF viewer frame disappeared before it was ready');
  await expect(pdf.locator('viewer-toolbar')).toBeVisible();
  await expect(pdf.locator('viewer-toolbar[loading_]')).toHaveCount(0);
  await expect(pdf.locator('viewer-thumbnail')).toHaveCount(2);
  // Capture the document with the browser's optional thumbnail sidebar collapsed using its real
  // control. This keeps the document visible at touch widths and avoids asynchronous thumbnail
  // bitmap/layout work becoming part of the application's visual contract.
  const sidebar = pdf.getByRole('button', {
    name: 'Toggle sidebar',
    exact: true,
    includeHidden: true,
  });
  // Chromium itself removes this control and the sidebar from its narrow embedded layout.
  if (!(await sidebar.isVisible())) {
    await expect(pdf.locator('#sidenav-container')).toBeHidden();
    return;
  }
  if ((await sidebar.getAttribute('aria-expanded')) === 'true') await sidebar.click();
  await expect(sidebar).toHaveAttribute('aria-expanded', 'false');
}
