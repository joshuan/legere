import { test, expect, settle } from './fixtures';
import type { Locator } from '@playwright/test';

async function expectReadableText(locator: Locator): Promise<void> {
  const ratio = await locator.evaluate((element) => {
    let surface: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (surface && background === 'rgba(0, 0, 0, 0)') {
      background = getComputedStyle(surface).backgroundColor;
      surface = surface.parentElement;
    }
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const text = luminance(getComputedStyle(element).color);
    const fill = luminance(background);
    return (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
}

test('brand actions, status tags and selected navigation retain readable rendered text', async ({
  page,
}, info) => {
  await page.goto('/settings');
  await settle(page);
  const primary = page.getByRole('button', { name: 'Change password', exact: true });
  await expectReadableText(primary);
  await primary.hover();
  await expectReadableText(primary);
  await expectReadableText(page.getByText('This device', { exact: true }));
  const secondary = page.getByRole('button', { name: 'Add integration', exact: true });
  await secondary.hover();
  await expectReadableText(secondary);

  await page.goto('/search');
  await settle(page);
  const width = info.project.use.viewport?.width ?? 1440;
  if (width < 768) {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  } else if (width < 1024) {
    await page.locator('.jui-sidebar .jui-navigation-toggle').click();
  }
  const selected = page
    .locator('.legere-navigation .ant-menu-item-selected')
    .filter({ visible: true });
  await expect(selected).toBeVisible();
  await expectReadableText(selected);
  await expectReadableText(selected.locator('.legere-search-shortcut'));
});

test('search hints retain readable contrast in the application theme', async ({
  page,
}, testInfo) => {
  await page.goto('/search');
  await settle(page);
  await page.getByText('Words and meaning', { exact: true }).hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toBeVisible();
  const colors = await tooltip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { foreground: style.color, background: style.backgroundColor };
  });
  const luminance = (color: string): number => {
    expect(color).toMatch(/^rgb\(/);
    const [red = 0, green = 0, blue = 0] = (color.match(/\d+/g) ?? []).map((value) => {
      const channel = Number(value) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const foreground = luminance(colors.foreground);
  const background = luminance(colors.background);
  expect(
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
  ).toBeGreaterThanOrEqual(4.5);
  await tooltip.screenshot({ path: testInfo.outputPath('search-mode-tooltip.png') });
});
