import '@testing-library/jest-dom/vitest';
import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { SessionsCard } from './sessions-card';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
}));

const other = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  userAgent: 'Mozilla/5.0 (a phone)',
  current: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-31T00:00:00.000Z',
};

const current = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  userAgent: null,
  current: true,
  createdAt: '2026-01-05T00:00:00.000Z',
  expiresAt: '2026-02-04T00:00:00.000Z',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/me/sessions', () => HttpResponse.json(envelope({ items: [other, current] }))),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// The sessions card on /settings (docs/11 §11.9, docs/08 §8.2).
describe('SessionsCard', () => {
  it('lists the signed-in devices and marks the one asking', async () => {
    renderWithProviders(<SessionsCard />);

    expect(await screen.findByText('Mozilla/5.0 (a phone)')).toBeInTheDocument();
    // A session that never carried a user agent still has a row to revoke.
    expect(screen.getByText(enMessages.settings.sessions.unknownDevice)).toBeInTheDocument();
    expect(screen.getByText(enMessages.settings.sessions.current)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: enMessages.settings.sessions.revoke }),
    ).toHaveLength(2);
  });

  it('revokes the chosen session and refreshes the list', async () => {
    let revokedId: string | null = null;
    server.use(
      http.delete('/api/me/sessions/:id', ({ params }) => {
        revokedId = String(params['id']);
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<SessionsCard />);

    const rows = await screen.findAllByRole('button', {
      name: enMessages.settings.sessions.revoke,
    });
    const first = rows[0];
    if (first === undefined) throw new Error('the list never rendered');
    await user.click(first);

    // The popconfirm asks before anything is sent (docs/11 §11.9); its OK button is the new one.
    const buttons = await screen.findAllByRole('button', {
      name: enMessages.settings.sessions.revoke,
    });
    const confirm = buttons.at(-1);
    if (confirm === undefined) throw new Error('the popconfirm never opened');
    await user.click(confirm);

    await waitFor(() => expect(revokedId).toBe(other.id));
  });

  it('warns before signing out the device asking the question', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SessionsCard />);

    const rows = await screen.findAllByRole('button', {
      name: enMessages.settings.sessions.revoke,
    });
    const currentRow = rows[1];
    if (currentRow === undefined) throw new Error('the current session has no row');
    await user.click(currentRow);

    expect(
      await screen.findByText(enMessages.settings.sessions.revokeCurrentConfirm),
    ).toBeInTheDocument();
  });

  // 🔒 SEC-68 (docs/10 §10.5). This is the second of the two ways a session ends, and the one that
  // used to leave the previous person's archive in the cache for whoever signed in next.
  it('empties the cache when it is this browser’s own session that ends', async () => {
    const cleared = vi.spyOn(QueryClient.prototype, 'clear');
    server.use(
      http.delete('/api/me/sessions/:id', () => HttpResponse.json(envelope({ ok: true }))),
    );
    const user = userEvent.setup();
    renderWithProviders(<SessionsCard />);

    const rows = await screen.findAllByRole('button', {
      name: enMessages.settings.sessions.revoke,
    });
    const currentRow = rows[1];
    if (currentRow === undefined) throw new Error('the current session has no row');
    await user.click(currentRow);

    const buttons = await screen.findAllByRole('button', {
      name: enMessages.settings.sessions.revoke,
    });
    const confirm = buttons.at(-1);
    if (confirm === undefined) throw new Error('the popconfirm never opened');
    await user.click(confirm);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
  });
});
