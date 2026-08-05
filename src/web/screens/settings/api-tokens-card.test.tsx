import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { ApiTokensCard } from './api-tokens-card';

const active = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'export script',
  status: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-04-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};

const revoked = {
  ...active,
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'old laptop',
  status: 'REVOKED',
  revokedAt: '2026-01-05T00:00:00.000Z',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/me/api-tokens', () =>
      HttpResponse.json(envelope({ items: [active, revoked] })),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The API tokens card on /settings (docs/11 §11.9, docs/08 §8.2a).
describe('ApiTokensCard', () => {
  it('lists tokens with their status and offers revocation only for the living one', async () => {
    renderWithProviders(<ApiTokensCard />);

    expect(await screen.findByText('export script')).toBeInTheDocument();
    expect(screen.getByText('old laptop')).toBeInTheDocument();
    expect(screen.getByText(enMessages.settings.apiTokens.statuses.ACTIVE)).toBeInTheDocument();
    expect(screen.getByText(enMessages.settings.apiTokens.statuses.REVOKED)).toBeInTheDocument();
    // Never used yet, and the table says so rather than showing an empty cell.
    expect(screen.getAllByText(enMessages.settings.apiTokens.never)).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: enMessages.settings.apiTokens.revoke })).toHaveLength(
      1,
    );
  });

  it('shows the new token once, with a warning that it cannot be retrieved', async () => {
    server.use(
      http.post('/api/me/api-tokens', () =>
        HttpResponse.json(envelope({ token: 'legere_a-real-secret', apiToken: active })),
      ),
    );
    const user = userEvent.setup();
    renderWithProviders(<ApiTokensCard />);

    await user.click(await screen.findByRole('button', { name: enMessages.settings.apiTokens.create }));
    await user.type(
      await screen.findByLabelText(enMessages.settings.apiTokens.name),
      'a backup script',
    );
    await user.click(screen.getByRole('button', { name: enMessages.settings.apiTokens.submit }));

    // Antd renders the value into both the field and its copy helper; one sighting is the point.
    expect((await screen.findAllByDisplayValue('legere_a-real-secret')).length).toBeGreaterThan(0);
    expect(screen.getByText(enMessages.settings.apiTokens.issuedWarning)).toBeInTheDocument();
  });

  it('revokes a token and refreshes the list', async () => {
    let revokedId: string | null = null;
    server.use(
      http.delete('/api/me/api-tokens/:id', ({ params }) => {
        revokedId = String(params['id']);
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ApiTokensCard />);

    await user.click(
      await screen.findByRole('button', { name: enMessages.settings.apiTokens.revoke }),
    );
    // The popconfirm asks before anything is sent (docs/11 §11.9); its OK button is the new one.
    const buttons = await screen.findAllByRole('button', {
      name: enMessages.settings.apiTokens.revoke,
    });
    const confirm = buttons.at(-1);
    if (confirm === undefined) throw new Error('the popconfirm never opened');
    await user.click(confirm);

    await waitFor(() => expect(revokedId).toBe(active.id));
  });
});
