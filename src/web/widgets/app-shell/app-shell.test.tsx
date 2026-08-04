import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '../../../shared/contracts/auth';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AppShell } from './app-shell';

const replace = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => '/documents',
}));

const USER: UserDto = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'admin@legere.local',
  displayName: 'Ada',
  role: 'ADMIN',
  language: 'EN',
  theme: 'SYSTEM',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/libraries', () => HttpResponse.json(envelope({ items: [] }))),
    http.post('/api/auth/logout', () => HttpResponse.json(envelope({ ok: true }))),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AppShell', () => {
  it('signs the user out through the API and sends them to the login screen', async () => {
    // Logging out used to be a link to /logout — a page that does not exist, so the only thing it
    // reliably produced was a 404 (docs/11 §11.1).
    let loggedOut = false;
    server.use(
      http.post('/api/auth/logout', () => {
        loggedOut = true;
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );

    renderWithProviders(
      <AppShell user={USER}>
        <p>content</p>
      </AppShell>,
    );

    await userEvent.click(
      screen.getByRole('menuitem', { name: new RegExp(enMessages.nav.logout) }),
    );

    await waitFor(() => expect(loggedOut).toBe(true));
    expect(replace).toHaveBeenCalledWith('/login');
  });

  it('says so when signing out fails, instead of pretending the session ended', async () => {
    server.use(
      http.post('/api/auth/logout', () => HttpResponse.json({ error: null }, { status: 500 })),
    );

    renderWithProviders(
      <AppShell user={USER}>
        <p>content</p>
      </AppShell>,
    );

    await userEvent.click(
      screen.getByRole('menuitem', { name: new RegExp(enMessages.nav.logout) }),
    );

    await waitFor(() =>
      expect(screen.getByText(enMessages.errors.codes.INTERNAL)).toBeInTheDocument(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers every section, and the admin area only to an admin', () => {
    renderWithProviders(
      <AppShell user={USER}>
        <p>content</p>
      </AppShell>,
    );

    for (const label of [
      enMessages.nav.documents,
      enMessages.nav.search,
      enMessages.nav.collections,
      enMessages.nav.scanSets,
      enMessages.nav.settings,
    ]) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getAllByText(enMessages.nav.administration).length).toBeGreaterThan(0);
  });

  it('keeps the admin section away from a regular user', async () => {
    renderWithProviders(
      <AppShell user={{ ...USER, role: 'USER' }}>
        <p>content</p>
      </AppShell>,
    );

    await screen.findByRole('menuitem', { name: new RegExp(enMessages.nav.documents) });
    expect(screen.queryByText(enMessages.nav.administration)).not.toBeInTheDocument();
  });

  it('every navigable item points at a route the app actually has', () => {
    renderWithProviders(
      <AppShell user={USER}>
        <p>content</p>
      </AppShell>,
    );

    // The routes under src/app; anything the shell links to has to be one of them.
    const routes = [
      '/documents',
      '/search',
      '/collections',
      '/scan-sets',
      '/settings',
      '/admin/libraries',
      '/admin/users',
      '/admin/document-types',
      '/admin/people',
      '/admin/subjects',
      '/admin/subject-kinds',
      '/admin/queue',
    ];
    for (const link of screen.getAllByRole('link')) {
      const href = link.getAttribute('href') ?? '';
      expect(routes.some((route) => href === route || href.startsWith('/browse/'))).toBe(true);
    }
  });
});
