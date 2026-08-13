import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrashItemDto } from '../../../shared/contracts/trash';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminTrashScreen } from './admin-trash-screen';

const MANAGED_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const LIBRARY_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const NEW_DOCUMENT_ID = 'cccccccc-3333-4333-8333-333333333333';

// An upload of ours: the sweep will delete it, and the row says on which day (docs/11 §11.13b).
const managed: TrashItemDto = {
  id: MANAGED_ID,
  name: 'passport-scan.jpg',
  mimeType: 'image/jpeg',
  ext: 'jpg',
  sizeBytes: '2097152',
  origin: 'MANAGED',
  available: true,
  isImage: true,
  reason: 'REPLACED',
  trashedAt: '2026-02-10T09:00:00.000Z',
  trashedFrom: 'Rental agreement',
  purgeAfter: '2026-03-12T09:00:00.000Z',
  refs: [],
  storageKey: 'files/aa/bb/original',
};

// An original on a read-only volume: nothing will ever sweep it, because nothing can (ADR-007).
const library: TrashItemDto = {
  id: LIBRARY_ID,
  name: 'invoice-2019.pdf',
  mimeType: 'application/pdf',
  ext: 'pdf',
  sizeBytes: '524288',
  origin: 'LIBRARY',
  available: true,
  isImage: false,
  reason: 'DOCUMENT_DELETED',
  trashedAt: '2026-02-09T09:00:00.000Z',
  trashedFrom: null,
  purgeAfter: null,
  refs: [
    {
      libraryId: 'dddddddd-4444-4444-8444-444444444444',
      libraryName: 'Archive',
      path: 'invoices/2019/invoice-2019.pdf',
      status: 'HASHED',
    },
  ],
  storageKey: null,
};

// Three items and 1.8 GB over the whole trash, of which this page shows two: the summary is the
// answer to "what is this costing me", not a count of the rows on screen (docs/11 §11.13b).
const page = {
  items: [managed, library],
  nextCursor: null,
  total: { items: 3, bytes: '1932735283' },
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(http.get('/api/admin/trash', () => HttpResponse.json(envelope(page))));
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

// The row a file's name sits in, so an assertion about one file cannot be satisfied by another.
async function rowOf(name: string): Promise<HTMLElement> {
  const row = (await screen.findByText(name)).closest('tr');
  if (!(row instanceof HTMLElement)) throw new Error(`expected a row for ${name}`);
  return row;
}

describe('AdminTrashScreen', () => {
  it('says what the whole trash holds, not what this page shows', async () => {
    renderWithProviders(<AdminTrashScreen />);

    // Two rows, three files: the figure comes from the answer's total (docs/11 §11.13b).
    expect(await screen.findByText('3 files, 1.8 GB')).toBeInTheDocument();
    expect(await screen.findByText('passport-scan.jpg')).toBeInTheDocument();
    expect(screen.getByText('invoice-2019.pdf')).toBeInTheDocument();
  });

  it('says the date a file of ours goes, and where it came from', async () => {
    renderWithProviders(<AdminTrashScreen />);
    const row = await rowOf('passport-scan.jpg');

    // A date, not "in 27 days": a date survives being read a week later (docs/11 §11.13b).
    const purgeDate = new Date(managed.purgeAfter ?? '').toLocaleDateString();
    expect(within(row).getByText(`Deleted on ${purgeDate}`)).toBeInTheDocument();
    // The title the document had, and why the file left it.
    expect(within(row).getByText('Rental agreement')).toBeInTheDocument();
    expect(within(row).getByText(enMessages.admin.trash.reasons.REPLACED)).toBeInTheDocument();
    expect(within(row).queryByText(enMessages.admin.trash.goesOnVolume)).not.toBeInTheDocument();
  });

  it('says a library original is never swept, names its path, and says what deleting it does', async () => {
    renderWithProviders(<AdminTrashScreen />);
    const row = await rowOf('invoice-2019.pdf');

    // 🔒 No countdown: Legere may not delete it and never will, and a date that will never arrive
    // would be a promise it cannot keep (docs/11 §11.13b).
    expect(within(row).getByText(enMessages.admin.trash.goesOnVolume)).toBeInTheDocument();
    expect(within(row).getByText('Archive: invoices/2019/invoice-2019.pdf')).toBeInTheDocument();
    // So nobody empties the trash expecting the disk to get smaller.
    expect(within(row).getByText(enMessages.admin.trash.volumeNote)).toBeInTheDocument();
    // Its document is gone, so it has no title to name.
    expect(within(row).getByText(enMessages.admin.trash.unknownDocument)).toBeInTheDocument();
    // And never a date, because no sweep will ever come for it.
    expect(within(row).queryByText(/Deleted on/)).not.toBeInTheDocument();
  });

  it('explains that restoring makes a new document, and then points at the one it made', async () => {
    let restored: string | null = null;
    server.use(
      http.post('/api/admin/trash/:fileId/restore', ({ params }) => {
        restored = String(params.fileId);
        return HttpResponse.json(envelope({ documentId: NEW_DOCUMENT_ID }));
      }),
    );

    renderWithProviders(<AdminTrashScreen />);
    const row = await rowOf('passport-scan.jpg');
    await userEvent.click(
      within(row).getByRole('button', { name: enMessages.admin.trash.actions.restore }),
    );

    // It asks first, and says what it is about to do before it does it (docs/05 §5.7a).
    expect(
      await screen.findByText('Restore «passport-scan.jpg» as a new document?'),
    ).toBeInTheDocument();
    expect(screen.getByText(enMessages.admin.trash.restoreNote)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(restored).toBe(MANAGED_ID));
    // The document it made is the whole answer, and it is not the one the file came from.
    const link = await screen.findByRole('link', { name: enMessages.admin.trash.restored });
    expect(link).toHaveAttribute('href', `/documents/${NEW_DOCUMENT_ID}`);
  });

  it('deletes one file for good, after naming it', async () => {
    let deleted: string | null = null;
    server.use(
      http.delete('/api/admin/trash/:fileId', ({ params }) => {
        deleted = String(params.fileId);
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );

    renderWithProviders(<AdminTrashScreen />);
    const row = await rowOf('invoice-2019.pdf');
    await userEvent.click(
      within(row).getByRole('button', { name: enMessages.admin.trash.actions.delete }),
    );

    expect(await screen.findByText('Delete «invoice-2019.pdf» for good?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => expect(deleted).toBe(LIBRARY_ID));
    expect(await screen.findByText(enMessages.admin.trash.deleted)).toBeInTheDocument();
  });

  it('empties the whole trash behind a confirmation naming the same figures', async () => {
    let emptied = false;
    server.use(
      http.delete('/api/admin/trash', () => {
        emptied = true;
        return HttpResponse.json(envelope({ deleted: 3 }));
      }),
    );

    renderWithProviders(<AdminTrashScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.trash.actions.emptyAll }),
    );

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(enMessages.admin.trash.emptyTitle)).toBeInTheDocument();
    // The same figures the button stood beside, and what an original on a volume does not lose.
    expect(within(dialog).getByText(/3 files for good — 1\.8 GB/)).toBeInTheDocument();

    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.admin.trash.actions.emptyAll }),
    );

    await waitFor(() => expect(emptied).toBe(true));
    expect(await screen.findByText('3 files deleted.')).toBeInTheDocument();
  });

  it('says the trash is empty instead of drawing an empty table', async () => {
    server.use(
      http.get('/api/admin/trash', () =>
        HttpResponse.json(
          envelope({ items: [], nextCursor: null, total: { items: 0, bytes: '0' } }),
        ),
      ),
    );

    renderWithProviders(<AdminTrashScreen />);

    // Nothing here is not a problem, and it is said plainly (docs/11 §11.13b).
    expect(await screen.findByText(enMessages.admin.trash.empty)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    // Nothing to empty, so nothing offers to.
    expect(
      screen.queryByRole('button', { name: enMessages.admin.trash.actions.emptyAll }),
    ).not.toBeInTheDocument();
  });
});
