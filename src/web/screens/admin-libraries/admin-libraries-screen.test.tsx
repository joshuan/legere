import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminLibrariesScreen } from './admin-libraries-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const library = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Invoices',
  rootPath: 'invoices',
  enabled: true,
  visibility: 'RESTRICTED',
  scanIntervalMinutes: 15,
  excludeGlobs: [],
  userIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  counters: { files: 12, documents: 10, missing: 2 },
  lastScan: {
    startedAt: '2026-01-02T10:00:00.000Z',
    finishedAt: '2026-01-02T10:00:05.000Z',
    status: 'DONE',
  },
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/admin/libraries', () => HttpResponse.json(envelope({ items: [library] }))),
    http.get('/api/admin/users', () =>
      HttpResponse.json(envelope({ items: [], nextCursor: null })),
    ),
    http.get('/api/admin/library-path-candidates', ({ request }) => {
      const path = new URL(request.url).searchParams.get('path') ?? '';
      const dirs = path === '' ? [{ name: 'invoices' }, { name: 'receipts' }] : [{ name: '2026' }];
      return HttpResponse.json(envelope({ path, dirs }));
    }),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminLibrariesScreen', () => {
  it('shows the library with its counters and last scan', async () => {
    renderWithProviders(<AdminLibrariesScreen />);

    expect(await screen.findByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('invoices')).toBeInTheDocument();
    expect(screen.getByText('12 files · 10 documents · 2 missing')).toBeInTheDocument();
    expect(screen.getByText('DONE')).toBeInTheDocument();
    expect(screen.getByText(enMessages.admin.libraries.visibility.RESTRICTED)).toBeInTheDocument();
  });

  it('starts a scan and reports it', async () => {
    let scanned = false;
    server.use(
      http.post('/api/admin/libraries/:id/scan', () => {
        scanned = true;
        return HttpResponse.json(envelope({ scanRunId: 'bbbbbbbb-2222-4222-8222-222222222222' }));
      }),
    );

    renderWithProviders(<AdminLibrariesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.libraries.actions.scanNow }),
    );

    await waitFor(() => expect(scanned).toBe(true));
    expect(await screen.findByText(enMessages.admin.libraries.scanStarted)).toBeInTheDocument();
  });

  it('says so plainly when a scan is already running rather than treating it as an error', async () => {
    server.use(
      http.post('/api/admin/libraries/:id/scan', () =>
        HttpResponse.json(envelope({ alreadyRunning: true })),
      ),
    );

    renderWithProviders(<AdminLibrariesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.libraries.actions.scanNow }),
    );

    expect(
      await screen.findByText(enMessages.admin.libraries.scanAlreadyRunning),
    ).toBeInTheDocument();
  });

  it('toggles the enabled switch through the API', async () => {
    let patched: unknown = null;
    server.use(
      http.patch('/api/admin/libraries/:id', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...library, enabled: false }));
      }),
    );

    renderWithProviders(<AdminLibrariesScreen />);
    await userEvent.click(
      await screen.findByRole('switch', { name: enMessages.admin.libraries.columns.enabled }),
    );

    await waitFor(() => expect(patched).toEqual({ enabled: false }));
  });

  it('confirms a delete and names the library', async () => {
    renderWithProviders(<AdminLibrariesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.libraries.actions.delete }),
    );

    expect(await screen.findByText(/Delete “Invoices”\?/)).toBeInTheDocument();
  });

  describe('the create drawer', () => {
    it('browses folders with the picker and creates a library at the chosen path', async () => {
      let created: unknown = null;
      server.use(
        http.post('/api/admin/libraries', async ({ request }) => {
          created = await request.json();
          return HttpResponse.json(envelope(library), { status: 201 });
        }),
      );

      renderWithProviders(<AdminLibrariesScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.admin.libraries.actions.create }),
      );

      const drawer = await screen.findByRole('dialog');
      // Drill into a folder, then select it.
      await userEvent.click(await within(drawer).findByRole('button', { name: 'invoices/' }));
      await userEvent.click(
        await within(drawer).findByRole('button', {
          name: enMessages.admin.libraries.picker.select,
        }),
      );
      expect(within(drawer).getByText('Selected: invoices')).toBeInTheDocument();

      await userEvent.type(
        within(drawer).getByLabelText(enMessages.admin.libraries.fields.name),
        'Invoices',
      );
      await userEvent.click(
        within(drawer).getByRole('button', { name: enMessages.common.actions.save }),
      );

      await waitFor(() => expect(created).not.toBeNull());
      expect(created).toMatchObject({
        name: 'Invoices',
        rootPath: 'invoices',
        // Fail-closed default (docs/03 §3.3.6).
        visibility: 'RESTRICTED',
        scanIntervalMinutes: 15,
      });
    });

    it('surfaces a path conflict inline instead of silently failing', async () => {
      server.use(
        http.post('/api/admin/libraries', () =>
          HttpResponse.json(errorEnvelope('LIBRARY_PATH_CONFLICT'), { status: 409 }),
        ),
      );

      renderWithProviders(<AdminLibrariesScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.admin.libraries.actions.create }),
      );

      const drawer = await screen.findByRole('dialog');
      await userEvent.type(
        within(drawer).getByLabelText(enMessages.admin.libraries.fields.name),
        'Overlapping',
      );
      await userEvent.click(
        within(drawer).getByRole('button', { name: enMessages.common.actions.save }),
      );

      expect(
        await screen.findByText(enMessages.errors.codes.LIBRARY_PATH_CONFLICT),
      ).toBeInTheDocument();
    });

    it('shows the root path read-only when editing, since it cannot be changed', async () => {
      renderWithProviders(<AdminLibrariesScreen />);
      await userEvent.click(
        await screen.findByRole('button', { name: enMessages.admin.libraries.actions.edit }),
      );

      const drawer = await screen.findByRole('dialog');
      const pathField = within(drawer).getByLabelText(enMessages.admin.libraries.fields.rootPath);
      expect(pathField).toBeDisabled();
      expect(pathField).toHaveValue('invoices');
      // The picker is not offered on edit.
      expect(
        within(drawer).queryByRole('button', { name: enMessages.admin.libraries.picker.select }),
      ).not.toBeInTheDocument();
    });
  });
});
