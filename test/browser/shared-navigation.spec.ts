import { test, expect, screenshot } from './fixtures';

test('shared navigation preserves the home link and the chosen desktop width', async ({
  page,
}, info) => {
  await page.goto('/settings');
  const width = info.project.use.viewport?.width ?? 1440;
  const home = page.getByRole('link', { name: 'Legere', exact: true });
  if (width < 768) {
    await expect(
      page.locator('.jui-mobile-bar').getByRole('link', { name: 'Legere', exact: true }),
    ).toBeVisible();
    await home.click();
    await expect(page).toHaveURL('/documents');
    await expect(
      page
        .locator('#main-content')
        .getByText('Riverside apartment rental agreement', { exact: false })
        .first(),
    ).toBeVisible();
    const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
    await trigger.click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.locator('.jui-navigation-brand')).toHaveCSS('height', '64px');
    await expect(drawer.locator('.jui-brand-name')).toHaveText('Legere');
    await screenshot(page, 'shared-navigation', info);
    // A home link also closes the panel when the route is already home.
    await drawer.getByRole('link', { name: 'Legere', exact: true }).click();
    await expect(drawer).toBeHidden();
    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(drawer).toBeHidden();
    await page.setViewportSize({ width, height: 900 });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  } else {
    const sidebar = page.locator('.jui-sidebar');
    await expect(sidebar.locator('.jui-navigation-brand')).toHaveCSS('height', '64px');
    const toggle = sidebar.locator('.jui-navigation-toggle');
    await expect(toggle).toHaveCSS('height', '44px');
    await expect(sidebar).toHaveCSS('width', width < 1024 ? '64px' : '240px');
    if (width >= 1024) {
      const collapse = page.getByRole('button', { name: 'Collapse the menu', exact: true });
      await collapse.focus();
      await page.keyboard.press('Enter');
    }
    await expect(sidebar).toHaveCSS('width', '64px');
    expect((await toggle.boundingBox())?.width).toBeGreaterThanOrEqual(62);
    await expect(sidebar.locator('.jui-brand-name')).toBeHidden();
    await expect(home).toBeVisible();
    await home.click();
    await expect(page).toHaveURL('/documents');
    await expect(
      page
        .locator('#main-content')
        .getByText('Riverside apartment rental agreement', { exact: false })
        .first(),
    ).toBeVisible();
    await expect(sidebar).toHaveCSS('width', '64px');
    await screenshot(page, 'shared-navigation-collapsed', info);
    await page.getByRole('button', { name: 'Expand the menu', exact: true }).click();
    await expect(sidebar).toHaveCSS('width', '240px');
    await expect(sidebar.locator('.jui-brand-name')).toHaveText('Legere');
    await page.setViewportSize({ width: 768, height: 900 });
    await expect(sidebar).toHaveCSS('width', '240px');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sidebar).toHaveCSS('width', '240px');
  }
});
