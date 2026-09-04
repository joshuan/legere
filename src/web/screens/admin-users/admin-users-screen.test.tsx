import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminUsersScreen } from './admin-users-screen';

const admin = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  email: 'admin@legere.local',
  displayName: 'admin',
  role: 'ADMIN',
  deactivatedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const member = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  email: 'user@legere.local',
  displayName: 'user',
  role: 'USER',
  deactivatedAt: null,
  createdAt: '2026-01-02T00:00:00.000Z',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/admin/users', () =>
      HttpResponse.json(envelope({ items: [admin, member], nextCursor: null })),
    ),
    http.get('/api/admin/invites', () => HttpResponse.json(envelope({ items: [] }))),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('AdminUsersScreen', () => {
  it('lists users with their role and status', async () => {
    renderWithProviders(<AdminUsersScreen />);

    expect(await screen.findByText('admin@legere.local')).toBeInTheDocument();
    expect(screen.getByText('user@legere.local')).toBeInTheDocument();
    expect(screen.getAllByText(enMessages.admin.users.status.active)).toHaveLength(2);
  });

  it('shows the invite URL once, with a warning that it cannot be retrieved', async () => {
    server.use(
      http.post('/api/admin/invites', () =>
        HttpResponse.json(
          envelope({
            id: 'cccccccc-3333-4333-8333-333333333333',
            url: 'http://localhost:3000/invite#token=secret-token',
            role: 'USER',
            expiresAt: '2026-02-01T00:00:00.000Z',
          }),
          { status: 201 },
        ),
      ),
    );

    renderWithProviders(<AdminUsersScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.invites.actions.create }),
    );

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.admin.invites.actions.create }),
    );

    expect(await screen.findByText(enMessages.admin.oneTimeLink.warning)).toBeInTheDocument();
    const shown = await screen.findAllByDisplayValue(
      'http://localhost:3000/invite#token=secret-token',
    );
    expect(shown.length).toBeGreaterThan(0);
  });

  it('surfaces LAST_ADMIN as a toast when a demotion is refused', async () => {
    let patched = false;
    server.use(
      http.patch('/api/admin/users/:id', () => {
        patched = true;
        return HttpResponse.json(errorEnvelope('LAST_ADMIN'), { status: 409 });
      }),
    );

    renderWithProviders(<AdminUsersScreen />);
    await screen.findByText('admin@legere.local');

    // The admin row is first; demoting it is what the server refuses.
    const [demote] = screen.getAllByRole('button', {
      name: enMessages.admin.users.actions.makeUser,
    });
    if (demote === undefined) throw new Error('demote button not rendered');
    await userEvent.click(demote);
    await userEvent.click(await screen.findByRole('button', { name: 'OK' }));

    await waitFor(() => expect(patched).toBe(true));
    expect(await screen.findByText(enMessages.errors.codes.LAST_ADMIN)).toBeInTheDocument();
  });

  it('asks for confirmation before deactivating and names the account', async () => {
    renderWithProviders(<AdminUsersScreen />);
    await screen.findByText('user@legere.local');

    const [, deactivateMember] = screen.getAllByRole('button', {
      name: enMessages.admin.users.actions.deactivate,
    });
    if (deactivateMember === undefined) throw new Error('deactivate button not rendered');
    await userEvent.click(deactivateMember);

    expect(await screen.findByText(/Deactivate user@legere.local/)).toBeInTheDocument();
  });

  it('reports how many sessions a revocation killed', async () => {
    server.use(
      http.post('/api/admin/users/:id/revoke-sessions', () =>
        HttpResponse.json(envelope({ revoked: 3 })),
      ),
    );

    renderWithProviders(<AdminUsersScreen />);
    await screen.findByText('user@legere.local');

    const [revoke] = screen.getAllByRole('button', {
      name: enMessages.admin.users.actions.revokeSessions,
    });
    if (revoke === undefined) throw new Error('revoke button not rendered');
    await userEvent.click(revoke);

    expect(await screen.findByText('Revoked 3 sessions')).toBeInTheDocument();
  });

  it('shows a reset link in the same one-time modal', async () => {
    server.use(
      http.post('/api/admin/users/:id/password-reset', () =>
        HttpResponse.json(
          envelope({
            url: 'http://localhost:3000/reset#token=reset-token',
            expiresAt: '2026-01-02T00:00:00.000Z',
          }),
          { status: 201 },
        ),
      ),
    );

    renderWithProviders(<AdminUsersScreen />);
    await screen.findByText('user@legere.local');

    const [resetLink] = screen.getAllByRole('button', {
      name: enMessages.admin.users.actions.resetLink,
    });
    if (resetLink === undefined) throw new Error('reset button not rendered');
    await userEvent.click(resetLink);

    const shown = await screen.findAllByDisplayValue(
      'http://localhost:3000/reset#token=reset-token',
    );
    expect(shown.length).toBeGreaterThan(0);
  });
});
