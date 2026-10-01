import { test, expect, settle } from './fixtures';

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
