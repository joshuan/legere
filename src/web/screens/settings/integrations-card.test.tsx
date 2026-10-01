import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { IntegrationsCard } from './integrations-card';
import { OAuthGrantsCard } from './oauth-grants-card';

const id = 'aaaaaaaa-1111-4111-8111-111111111111';
const createdAt = '2026-01-01T00:00:00.000Z';
const service = { id, name: 'Rent Manage', createdAt, revokedAt: null, documentCount: 2 };
const server = createApiMock();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() =>
  server.use(
    http.get('/api/me/integrations', () => HttpResponse.json(envelope({ items: [service] }))),
  ),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Integration and OAuth settings', () => {
  it('creates an integration, issues its scoped token and only displays the secret until dismissed', async () => {
    let created: unknown;
    let issued: unknown;
    server.use(
      http.post('/api/me/integrations', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(envelope(service));
      }),
      http.post('/api/me/integrations/:id/tokens', async ({ request, params }) => {
        expect(params['id']).toBe(id);
        issued = await request.json();
        return HttpResponse.json(
          envelope({
            token: 'legere_service-secret',
            apiToken: {
              id,
              name: 'Rent Manage',
              scope: 'INTEGRATION',
              status: 'ACTIVE',
              createdAt,
              expiresAt: '2027-01-01T00:00:00.000Z',
              lastUsedAt: null,
              revokedAt: null,
            },
          }),
        );
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<IntegrationsCard />);
    expect(await screen.findByText('Rent Manage')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: enMessages.integrations.openapi })).toHaveAttribute(
      'href',
      '/api/openapi.json',
    );
    await user.click(screen.getByRole('button', { name: enMessages.integrations.create }));
    await user.type(await screen.findByLabelText(enMessages.integrations.name), 'Rent Manage');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: enMessages.integrations.create,
      }),
    );
    await waitFor(() => expect(created).toEqual({ name: 'Rent Manage' }));
    const name = await screen.findByLabelText(enMessages.settings.apiTokens.name);
    expect(name).toHaveValue('Rent Manage');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: enMessages.integrations.issue,
      }),
    );
    expect((await screen.findAllByDisplayValue('legere_service-secret')).length).toBeGreaterThan(0);
    expect(issued).toEqual({ name: 'Rent Manage', expiresInDays: 90 });
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('textbox', { name: enMessages.settings.apiTokens.issuedTitle }),
      ).not.toBeInTheDocument(),
    );
  });

  it('requires confirmation before revoking an integration', async () => {
    let revoked = false;
    server.use(
      http.delete('/api/me/integrations/:id', () => {
        revoked = true;
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<IntegrationsCard />);
    await user.click(await screen.findByRole('button', { name: enMessages.integrations.revoke }));
    expect(revoked).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(revoked).toBe(true));
  });

  it('shows registered application identity and disconnects only the selected grant', async () => {
    let revokedId: string | null = null;
    server.use(
      http.get('/api/me/oauth-grants', () =>
        HttpResponse.json(
          envelope({
            items: [
              {
                id,
                clientId: id,
                clientName: 'Cloud agent',
                scope: 'mcp:read',
                createdAt,
                expiresAt: '2099-01-01T00:00:00.000Z',
                revokedAt: null,
              },
            ],
          }),
        ),
      ),
      http.delete('/api/me/oauth-grants/:id', ({ params }) => {
        revokedId = String(params['id']);
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<OAuthGrantsCard />);
    expect(await screen.findByText('Cloud agent')).toBeInTheDocument();
    expect(screen.getByText(`Client ID: ${id}`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: enMessages.oauth.revoke }));
    expect(revokedId).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'OK' }));
    await waitFor(() => expect(revokedId).toBe(id));
  });
});
