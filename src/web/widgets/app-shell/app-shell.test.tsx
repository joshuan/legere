import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserDto } from '../../../shared/contracts/auth';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AppShell } from './app-shell';

const replace = vi.fn();
const push = vi.fn();
let pathname = '/documents';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push }),
  usePathname: () => pathname,
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
    // Recent documents are available to the search page.
    http.get('/api/documents', () => HttpResponse.json(envelope({ items: [], nextCursor: null }))),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
  pathname = '/documents';
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
      <AppShell user={USER} version="9.9.9">
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
      <AppShell user={USER} version="9.9.9">
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

  it('offers every section, and the admin area only to an admin', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    await screen.findByText('content');
    for (const label of [
      enMessages.nav.documents,
      enMessages.nav.search,
      enMessages.nav.collections,
      enMessages.nav.settings,
    ]) {
      expect(screen.getByRole('menuitem', { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getAllByText(enMessages.nav.administration).length).toBeGreaterThan(0);
  });

  it('links to the search page from the menu', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );
    expect(await screen.findByRole('link', { name: /Search/ })).toHaveAttribute('href', '/search');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['ctrlKey', 'metaKey'])('opens the search page with %s+K', async (modifier) => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );
    await screen.findByText('content');
    fireEvent.keyDown(window, { key: 'k', [modifier]: true });
    expect(push).toHaveBeenCalledWith('/search');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('focuses the existing search input without clearing it or navigating again', async () => {
    pathname = '/search';
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <input id="document-search-input" aria-label="query" defaultValue="invoice" />
      </AppShell>,
    );
    const input = await screen.findByRole('textbox', { name: 'query' });
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(input).toHaveFocus();
    expect(input).toHaveValue('invoice');
    expect(push).not.toHaveBeenCalled();
  });

  it('writes the chord beside the item that offers it', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    // A shortcut nobody is told about is a shortcut for the person who wrote it (docs/11 §11.1a).
    const item = await screen.findByRole('menuitem', { name: new RegExp(enMessages.nav.search) });
    expect(item.textContent).toMatch(/(⌘K|Ctrl\+K)$/);
  });

  it('draws no bar across the top of the content', async () => {
    const { container } = renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    // 🔒 The shell is the column and the content, and nothing else (docs/11 §11.1): the title
    // repeated the menu item beside it, and the global search input is raised on demand instead.
    await screen.findByText('content');
    expect(container.querySelector('header')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('says which build this is, at the foot of the menu', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    // Nobody comes looking for it until something is wrong, and then it is the first thing asked
    // for (docs/11 §11.1).
    expect(await screen.findByText('Version 9.9.9')).toBeInTheDocument();
  });

  it('signs the person in the foot of the column, not the corner of the page', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    const name = await screen.findByText(USER.displayName);
    // Who is signed in belongs with what they may do about it — settings, logout — rather than in
    // the top bar, which is for the screen being read (docs/11 §11.1).
    expect(name.closest('aside')).not.toBeNull();
  });

  it('keeps the column with the window rather than letting it travel with the page', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    // 🔒 "Sits still while the menu grows" is worth nothing if the whole column leaves the screen
    // the moment somebody scrolls a long grid (docs/11 §11.1). jsdom computes no layout, so what is
    // asserted is the rule that pins it.
    const sider = (await screen.findByText(USER.displayName)).closest('aside');
    expect(sider).toHaveStyle({ position: 'sticky', top: '0px', height: '100vh' });
  });

  it('narrows the column with a control that says what it does', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    const trigger = await screen.findByRole('button', { name: enMessages.nav.collapse });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(trigger);

    expect(await screen.findByRole('button', { name: enMessages.nav.expand })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('keeps the admin section away from a regular user', async () => {
    renderWithProviders(
      <AppShell user={{ ...USER, role: 'USER' }} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    await screen.findByRole('menuitem', { name: new RegExp(enMessages.nav.documents) });
    expect(screen.queryByText(enMessages.nav.administration)).not.toBeInTheDocument();
  });

  it('every navigable item points at a route the app actually has', async () => {
    renderWithProviders(
      <AppShell user={USER} version="9.9.9">
        <p>content</p>
      </AppShell>,
    );

    await screen.findByText('content');
    // The routes under src/app; anything the shell links to has to be one of them.
    const routes = [
      '/documents',
      '/receipts',
      '/search',
      '/collections',
      '/settings',
      '/people',
      '/subjects',
      '/subject-kinds',
      '/document-types',
      '/admin/libraries',
      '/admin/users',
      '/admin/processing',
    ];
    for (const link of screen.getAllByRole('link')) {
      const href = link.getAttribute('href') ?? '';
      expect(routes.some((route) => href === route || href.startsWith('/browse/'))).toBe(true);
    }
  });
});
