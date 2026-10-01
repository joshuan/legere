import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { OAuthConsentScreen } from './oauth-consent-screen';

const navigation = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => navigation.params }));
const clientId = 'aaaaaaaa-1111-4111-8111-111111111111';
const server = createApiMock();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  navigation.params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: 'https://agent.example/callback',
    resource: 'https://legere.example/api/mcp',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'opaque-state',
  });
  server.use(
    http.get('/api/oauth/authorize/preview', () =>
      HttpResponse.json(
        envelope({
          clientId,
          clientName: 'Cloud agent',
          redirectOrigin: 'https://agent.example',
          scope: 'mcp:read',
        }),
      ),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('OAuth consent', () => {
  it('shows the authorizing user, application identity, callback and scope before any authorization', async () => {
    renderWithProviders(<OAuthConsentScreen />);
    expect(await screen.findByText('Cloud agent')).toBeInTheDocument();
    expect(screen.getByText(/Reader/)).toBeInTheDocument();
    expect(screen.getByText('https://agent.example')).toBeInTheDocument();
    expect(screen.getByText(enMessages.oauth.readScope)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: enMessages.oauth.allow })).toBeEnabled();
    expect(screen.getByRole('button', { name: enMessages.oauth.deny })).toBeEnabled();
  });
  it.each(['approve', 'deny'] as const)(
    'submits an explicit %s decision preserving PKCE and state',
    async (decision) => {
      let payload: unknown;
      server.use(
        http.post('/api/oauth/authorize', async ({ request }) => {
          payload = await request.json();
          return HttpResponse.json(
            { error: { code: 'VALIDATION_FAILED', message: 'Expired request', details: null } },
            { status: 422 },
          );
        }),
      );
      const user = userEvent.setup();
      renderWithProviders(<OAuthConsentScreen />);
      await user.click(
        await screen.findByRole('button', {
          name: decision === 'approve' ? enMessages.oauth.allow : enMessages.oauth.deny,
        }),
      );
      await waitFor(() =>
        expect(payload).toMatchObject({
          client_id: clientId,
          code_challenge: 'a'.repeat(43),
          state: 'opaque-state',
          decision,
        }),
      );
      expect(screen.getByText('Cloud agent')).toBeInTheDocument();
    },
  );
  it('offers no approval for malformed authorization requests', () => {
    navigation.params = new URLSearchParams('client_id=forged');
    renderWithProviders(<OAuthConsentScreen />);
    expect(screen.getByText(enMessages.oauth.invalidRequest)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enMessages.oauth.allow })).not.toBeInTheDocument();
  });
});
