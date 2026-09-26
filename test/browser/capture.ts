import { expect, type Page } from '@playwright/test';
import sharp from 'sharp';

// Chromium's beyond-viewport capture resets touch emulation and emits false media changes:
// https://github.com/microsoft/playwright/issues/42607. Capture real viewport tiles instead.
// Sticky/fixed chrome from the first tile must not repeat down the assembled document.
export async function captureFullPage(page: Page): Promise<Buffer> {
  const state = () =>
    page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      touchPoints: navigator.maxTouchPoints,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
    }));
  const before = await state();
  const focused = await page.evaluateHandle(() => document.activeElement);
  // Finish finite transitions before measuring the document, just as Playwright's full-page
  // capture does. A still-opening disclosure can otherwise make the assembled image too short.
  await page.screenshot({
    animations: 'disabled',
    clip: { x: 0, y: 0, width: 1, height: 1 },
  });
  const size = await page.evaluate(() => ({
    width: Math.max(
      document.documentElement.scrollWidth,
      document.documentElement.offsetWidth,
      document.documentElement.clientWidth,
      document.body.scrollWidth,
      document.body.offsetWidth,
      document.body.clientWidth,
    ),
    height: Math.max(
      document.documentElement.scrollHeight,
      document.documentElement.offsetHeight,
      document.documentElement.clientHeight,
      document.body.scrollHeight,
      document.body.offsetHeight,
      document.body.clientHeight,
    ),
  }));
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      const position = getComputedStyle(element).position;
      const rect = element.getBoundingClientRect();
      if (['sticky', 'fixed'].includes(position) && rect.top < innerHeight && rect.bottom > 0) {
        element.setAttribute('data-capture-chrome', '');
      }
    }
  });
  const tiles: { input: Buffer; left: number; top: number }[] = [];
  try {
    for (let top = 0; top < size.height; top += before.height) {
      const scroll = await page.evaluate(async (offset) => {
        window.scrollTo({ top: offset, left: 0, behavior: 'instant' });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return window.scrollY;
      }, top);
      let previous: Buffer | undefined;
      let captured: Buffer | undefined;
      await expect
        .poll(
          async () => {
            captured = await page.screenshot({
              animations: 'disabled',
              caret: 'hide',
              scale: 'css',
              clip: {
                x: 0,
                y: top - scroll,
                width: size.width,
                height: Math.min(before.height, size.height - top),
              },
              ...(top === 0
                ? {}
                : {
                    style:
                      '[data-capture-chrome], [data-capture-chrome] * { visibility: hidden !important; }',
                  }),
            });
            const stable = previous?.equals(captured) ?? false;
            previous = captured;
            return stable;
          },
          { message: 'two consecutive viewport captures must be identical', timeout: 10_000 },
        )
        .toBe(true);
      if (captured === undefined) throw new Error('No viewport screenshot was captured');
      tiles.push({ input: captured, left: 0, top });
    }
    expect(await state(), 'capture must preserve viewport and touch emulation').toEqual(before);
    return await sharp({
      create: { width: size.width, height: size.height, channels: 4, background: '#fff' },
    })
      .composite(tiles)
      .png()
      .toBuffer();
  } finally {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll('[data-capture-chrome]')) {
        element.removeAttribute('data-capture-chrome');
      }
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    });
    // Hiding fixed chrome between tiles can blur a modal's focus trap. Capturing an image must
    // leave keyboard interaction where it was, without scrolling the restored focus into view.
    await focused.evaluate((element) => {
      if (element instanceof HTMLElement && element.isConnected) {
        element.focus({ preventScroll: true });
      }
    });
    await focused.dispose();
  }
}
