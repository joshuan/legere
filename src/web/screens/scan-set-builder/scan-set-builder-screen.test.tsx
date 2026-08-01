import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScanSetDetailDto } from '../../../shared/contracts/scan-sets';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { ScanSetBuilderScreen } from './scan-set-builder-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PAGE_ONE = 'bbbbbbbb-2222-4222-8222-222222222222';
const PAGE_TWO = 'cccccccc-3333-4333-8333-333333333333';

const draft: ScanSetDetailDto = {
  id: ID,
  name: 'Passport',
  status: 'DRAFT',
  cropMode: 'TRIM',
  itemCount: 2,
  resultDocumentId: null,
  error: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  items: [
    { documentId: PAGE_ONE, position: 0, title: 'Page one', hasPreview: true },
    { documentId: PAGE_TWO, position: 1, title: 'Page two', hasPreview: false },
  ],
};

const server = createApiMock();

function serve(detail: ScanSetDetailDto): void {
  server.use(http.get(`/api/scan-sets/${ID}`, () => HttpResponse.json(envelope(detail))));
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => serve(draft));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('ScanSetBuilderScreen', () => {
  it('shows the pages in order with their thumbnails', async () => {
    renderWithProviders(<ScanSetBuilderScreen id={ID} />);

    expect(await screen.findByText('1. Page one')).toBeInTheDocument();
    expect(screen.getByText('2. Page two')).toBeInTheDocument();
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });

  it('reorders a page and sends the whole new order', async () => {
    let sent: unknown = null;
    server.use(
      http.patch(`/api/scan-sets/${ID}`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope(draft));
      }),
    );

    renderWithProviders(<ScanSetBuilderScreen id={ID} />);
    await userEvent.click(await screen.findByRole('button', { name: /Move page 2 earlier/ }));

    // Positions are a contiguous order, so the whole list travels (docs/03 §3.3.17).
    await waitFor(() => expect(sent).toEqual({ items: [PAGE_TWO, PAGE_ONE] }));
  });

  it('toggles margin trimming', async () => {
    let sent: unknown = null;
    server.use(
      http.patch(`/api/scan-sets/${ID}`, async ({ request }) => {
        sent = await request.json();
        return HttpResponse.json(envelope({ ...draft, cropMode: 'NONE' }));
      }),
    );

    renderWithProviders(<ScanSetBuilderScreen id={ID} />);
    await userEvent.click(
      await screen.findByRole('switch', { name: enMessages.scanSets.trimMargins }),
    );

    await waitFor(() => expect(sent).toEqual({ cropMode: 'NONE' }));
  });

  it('merges the set', async () => {
    let merged = false;
    server.use(
      http.post(`/api/scan-sets/${ID}/merge`, () => {
        merged = true;
        return HttpResponse.json(envelope({ ...draft, status: 'QUEUED' }));
      }),
    );

    renderWithProviders(<ScanSetBuilderScreen id={ID} />);
    await userEvent.click(await screen.findByRole('button', { name: enMessages.scanSets.merge }));

    await waitFor(() => expect(merged).toBe(true));
    expect(await screen.findByText(enMessages.scanSets.queued)).toBeInTheDocument();
  });

  it('locks the builder while a merge is in flight', async () => {
    serve({ ...draft, status: 'PROCESSING' });

    renderWithProviders(<ScanSetBuilderScreen id={ID} />);

    // 🔒 A merge in flight must not have the ground moved under it (docs/03 §3.3.16).
    expect(await screen.findByRole('button', { name: enMessages.scanSets.merge })).toBeDisabled();
    expect(screen.getByRole('switch', { name: enMessages.scanSets.trimMargins })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Move page/ })).not.toBeInTheDocument();
  });

  it('shows the error of a failed merge and keeps the set editable', async () => {
    serve({ ...draft, status: 'FAILED', error: 'Stirling failed with 500' });

    renderWithProviders(<ScanSetBuilderScreen id={ID} />);

    expect(await screen.findByText('Stirling failed with 500')).toBeInTheDocument();
    // Fix the pages, merge again (docs/05 §5.6).
    expect(screen.getByRole('button', { name: enMessages.scanSets.merge })).not.toBeDisabled();
  });

  it('links to the result once the merge is done', async () => {
    serve({
      ...draft,
      status: 'DONE',
      resultDocumentId: 'dddddddd-4444-4444-8444-444444444444',
    });

    renderWithProviders(<ScanSetBuilderScreen id={ID} />);

    expect(await screen.findByText(enMessages.scanSets.done)).toBeInTheDocument();
    expect(screen.getByText(enMessages.scanSets.openResult)).toBeInTheDocument();
  });
});
