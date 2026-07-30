import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminLibraryDetailScreen } from './admin-library-detail-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const LIBRARY_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

const library = {
  id: LIBRARY_ID,
  name: 'Invoices',
  rootPath: 'invoices',
  enabled: true,
  visibility: 'ALL_USERS',
  scanIntervalMinutes: 30,
  excludeGlobs: ['**/node_modules/**'],
  userIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const finishedRun = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  status: 'DONE',
  startedAt: '2026-01-02T10:00:00.000Z',
  finishedAt: '2026-01-02T10:00:07.000Z',
  filesSeen: 9,
  filesNew: 3,
  filesChanged: 1,
  filesMissing: 2,
  error: null,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get(`/api/admin/libraries/${LIBRARY_ID}`, () => HttpResponse.json(envelope(library))),
    http.get(`/api/admin/libraries/${LIBRARY_ID}/scans`, () =>
      HttpResponse.json(envelope({ items: [finishedRun], nextCursor: null })),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminLibraryDetailScreen', () => {
  it('shows the library settings', async () => {
    renderWithProviders(<AdminLibraryDetailScreen id={LIBRARY_ID} />);

    expect(await screen.findByText('Invoices')).toBeInTheDocument();
    expect(screen.getByText('invoices')).toBeInTheDocument();
    expect(screen.getByText(enMessages.admin.libraries.visibility.ALL_USERS)).toBeInTheDocument();
    expect(screen.getByText('30 min')).toBeInTheDocument();
    expect(screen.getByText('**/node_modules/**')).toBeInTheDocument();
  });

  it('shows the journal with duration and counters', async () => {
    renderWithProviders(<AdminLibraryDetailScreen id={LIBRARY_ID} />);

    expect(await screen.findByText('DONE')).toBeInTheDocument();
    expect(screen.getByText('7s')).toBeInTheDocument();
    expect(screen.getByText('9 seen · 3 new · 1 changed · 2 missing')).toBeInTheDocument();
  });

  // The live refresh is a real 5 s interval (docs/10 §10.5), so this test waits past it rather than
  // faking timers, which react-query and antd both interact with badly.
  it('updates a running row in place until the scan finishes', { timeout: 20_000 }, async () => {
    // First poll returns a RUNNING row, the next one the finished record (docs/11 §11.10).
    let call = 0;
    server.use(
      http.get(`/api/admin/libraries/${LIBRARY_ID}/scans`, () => {
        call += 1;
        const running = {
          ...finishedRun,
          status: 'RUNNING',
          finishedAt: null,
          filesSeen: 4,
          filesNew: 4,
          filesChanged: 0,
          filesMissing: 0,
        };
        return HttpResponse.json(
          envelope({ items: [call === 1 ? running : finishedRun], nextCursor: null }),
        );
      }),
    );

    renderWithProviders(<AdminLibraryDetailScreen id={LIBRARY_ID} />);

    expect(await screen.findByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText(enMessages.admin.libraries.scans.inProgress)).toBeInTheDocument();

    // The poll fires because a row is running; once it is not, the tag settles.
    await waitFor(() => expect(screen.getByText('DONE')).toBeInTheDocument(), { timeout: 15_000 });
    expect(call).toBeGreaterThan(1);
  });

  it('triggers a scan from the detail page', async () => {
    let scanned = false;
    server.use(
      http.post(`/api/admin/libraries/${LIBRARY_ID}/scan`, () => {
        scanned = true;
        return HttpResponse.json(envelope({ scanRunId: 'cccccccc-3333-4333-8333-333333333333' }));
      }),
    );

    renderWithProviders(<AdminLibraryDetailScreen id={LIBRARY_ID} />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.libraries.actions.scanNow }),
    );

    await waitFor(() => expect(scanned).toBe(true));
    expect(await screen.findByText(enMessages.admin.libraries.scanStarted)).toBeInTheDocument();
  });

  it('shows a scan error when one was recorded', async () => {
    server.use(
      http.get(`/api/admin/libraries/${LIBRARY_ID}/scans`, () =>
        HttpResponse.json(
          envelope({
            items: [{ ...finishedRun, error: 'Could not read 1 directory:\nlocked: EACCES' }],
            nextCursor: null,
          }),
        ),
      ),
    );

    renderWithProviders(<AdminLibraryDetailScreen id={LIBRARY_ID} />);

    expect(await screen.findByText(/locked: EACCES/)).toBeInTheDocument();
  });
});
