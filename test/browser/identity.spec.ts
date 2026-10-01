import { createHash } from 'node:crypto';
import { z } from 'zod';
import { test, expect, screenshot } from './fixtures';
import { VISUAL_IDS } from './constants';

test('OAuth consent identifies the user and client and returns a denial with state', async ({
  page,
  request,
}, testInfo) => {
  const metadata = z
    .object({ resource: z.string() })
    .parse(await (await request.get('/.well-known/oauth-protected-resource/api/mcp')).json());
  const query = new URLSearchParams({
    client_id: VISUAL_IDS.oauthClient,
    redirect_uri: 'https://agent.example/callback',
    resource: metadata.resource,
    response_type: 'code',
    scope: 'mcp:read',
    state: 'browser-consent-state',
    code_challenge: createHash('sha256')
      .update('browser-verifier-0123456789012345678901234567890123456789')
      .digest('base64url'),
    code_challenge_method: 'S256',
  });
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByText('Cloud archive assistant', { exact: true })).toBeVisible();
  await expect(page.getByText(/Alex Morgan/).last()).toBeVisible();
  await expect(page.getByText('https://agent.example', { exact: false })).toBeVisible();
  await screenshot(page, 'oauth-consent', testInfo);
  await page.route('https://agent.example/callback**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Application callback</p>' }),
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/https:\/\/agent\.example\/callback\?.*error=access_denied/);
  expect(new URL(page.url()).searchParams.get('state')).toBe('browser-consent-state');
  expect(new URL(page.url()).searchParams.get('code')).toBeNull();
});

test('integration token form explains its scope and fits every viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/settings');
  await page
    .locator('.ant-card')
    .filter({ has: page.getByText('Service integrations', { exact: true }) })
    .getByRole('button', { name: 'Create token', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: /Name$/ })).toHaveValue(
    'Rent Manage',
  );
  await screenshot(page, 'integration-token', testInfo);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
});
