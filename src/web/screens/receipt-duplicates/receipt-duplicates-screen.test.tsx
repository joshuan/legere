import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import type { ReceiptDuplicatePair } from '../../../shared/contracts/receipt-duplicates';
import { resolveReceiptPairSchema } from '../../../shared/contracts/receipt-duplicates';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { ReceiptDuplicatesScreen } from './receipt-duplicates-screen';

const replace = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(search),
}));
const server = createApiMock();
const ROOT = '/api/receipts/duplicates';
const first: ReceiptListItemDto = {
  id: '10000000-0000-4000-8000-000000000001',
  fileName: 'fiscal.jpg',
  mimeType: 'image/jpeg',
  ext: 'jpg',
  sizeBytes: '2048',
  pageCount: 1,
  previewStatus: 'DONE',
  extractionStatus: 'DONE',
  processing: false,
  processingError: null,
  createdAt: '2026-09-30T12:00:00.000Z',
  updatedAt: '2026-09-30T12:00:00.000Z',
  owner: { id: '90000000-0000-4000-8000-000000000001', displayName: 'Reader' },
  extracted: {
    schema: { slug: 'receipt', version: 3 },
    confidence: 96,
    values: {
      vendor: 'Voli',
      purchasedAt: '2026-09-30',
      total: { amount: 24.8, currency: 'EUR' },
      items: [{ name: 'Coffee', quantity: 2, amount: 24.8 }],
    },
  },
};
const pair: ReceiptDuplicatePair = {
  first,
  second: {
    ...first,
    id: '20000000-0000-4000-8000-000000000002',
    fileName: 'terminal.jpg',
    extracted: {
      schema: { slug: 'receipt', version: 3 },
      confidence: 95,
      values: { vendor: 'Voli', total: { amount: 24.8, currency: 'EUR' }, card: '****1234' },
    },
  },
  revision: 'a'.repeat(64),
  kind: 'parts',
  reasons: ['date', 'total', 'merchant', 'time'],
  conflicts: ['number'],
  mergeBlocked: null,
};
const t = enMessages.receiptDuplicates;
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  search = '';
  replace.mockClear();
  server.use(
    http.get(ROOT, () =>
      HttpResponse.json(envelope({ items: [pair], nextCursor: null, checkedPairs: 1 })),
    ),
    http.get(`${ROOT}/history`, () => HttpResponse.json(envelope({ items: [], nextCursor: null }))),
    http.get('/api/receipts/:id/pages/0', () =>
      HttpResponse.json(envelope({ url: 'https://storage.test/receipt.jpg' })),
    ),
  );
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('receipt duplicate review', () => {
  it('shows comparison facts, conflicts, original page links and complementary item data', async () => {
    renderWithProviders(<ReceiptDuplicatesScreen />);
    expect(await screen.findByRole('heading', { name: t.kinds.parts })).toBeInTheDocument();
    expect(screen.getByText(t.conflicts)).toBeInTheDocument();
    expect(screen.getByText('Coffee × 2')).toBeInTheDocument();
    expect(screen.getByText(t.noItems)).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'Voli' }).map((link) => link.getAttribute('href')),
    ).toEqual([`/receipts/${first.id}`, `/receipts/${pair.second.id}`]);
  });

  it('does nothing until confirmation and retries an uncertain merge with the same operation id and page order', async () => {
    const received: unknown[] = [];
    let fail = true;
    server.use(
      http.post(`${ROOT}/resolve`, async ({ request }) => {
        const body = resolveReceiptPairSchema.parse(await request.json());
        received.push(body);
        return fail
          ? HttpResponse.json(
              { error: { code: 'INTERNAL', message: 'Temporary failure' } },
              { status: 500 },
            )
          : HttpResponse.json(
              envelope({
                id: body.operationId,
                action: body.action,
                reverse: body.reverse,
                pair,
                resultId: first.id,
                createdAt: first.createdAt,
                undoneAt: null,
                actor: first.owner,
              }),
            );
      }),
    );
    renderWithProviders(<ReceiptDuplicatesScreen />);
    await userEvent.click(await screen.findByRole('radio', { name: t.orderSecond }));
    await userEvent.click(screen.getByRole('button', { name: t.actions.MERGE }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(t.orderSecond)).toBeInTheDocument();
    expect(received).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole('button', { name: t.cancel }));
    expect(received).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: t.actions.MERGE }));
    dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: t.confirm }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      enMessages.errors.codes.INTERNAL,
    );
    fail = false;
    await userEvent.click(within(dialog).getByRole('button', { name: t.confirm }));
    await screen.findByText(t.saved);
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual(received[1]);
    expect(received[0]).toMatchObject({
      action: 'MERGE',
      reverse: true,
      revision: pair.revision,
      firstId: first.id,
      secondId: pair.second.id,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('continues a scan with no suggestions in its first batch instead of claiming completion', async () => {
    server.use(
      http.get(ROOT, ({ request }) =>
        HttpResponse.json(
          envelope(
            new URL(request.url).searchParams.has('cursor') &&
              new URL(request.url).searchParams.get('cursor') === 'next'
              ? { items: [pair], nextCursor: null, checkedPairs: 1 }
              : { items: [], nextCursor: 'next', checkedPairs: 200 },
          ),
        ),
      ),
    );
    renderWithProviders(<ReceiptDuplicatesScreen />);
    expect(await screen.findByText(t.scanMore)).toBeInTheDocument();
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: t.continueScan }));
    expect(await screen.findByRole('heading', { name: t.kinds.parts })).toBeInTheDocument();
  });

  it('opens a manually selected pair and disables merging while previews are unavailable', async () => {
    search = `firstId=${first.id}&secondId=${pair.second.id}`;
    server.use(
      http.get(`${ROOT}/compare`, () =>
        HttpResponse.json(envelope({ ...pair, kind: 'manual', mergeBlocked: 'preview' })),
      ),
    );
    renderWithProviders(<ReceiptDuplicatesScreen />);
    expect(await screen.findByRole('heading', { name: t.kinds.manual })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.actions.MERGE })).toBeDisabled();
    expect(screen.getByText(t.mergeBlocked.preview)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.actions.KEEP_FIRST })).toBeEnabled();
  });

  it('can inspect another candidate without recording a decision', async () => {
    const next = {
      ...pair,
      first: {
        ...first,
        id: '30000000-0000-4000-8000-000000000003',
        fileName: 'another-purchase.jpg',
      },
      revision: 'b'.repeat(64),
    };
    let decisions = 0;
    server.use(
      http.get(ROOT, () =>
        HttpResponse.json(envelope({ items: [pair, next], nextCursor: null, checkedPairs: 2 })),
      ),
      http.post(`${ROOT}/resolve`, () => {
        decisions += 1;
        return HttpResponse.json({});
      }),
    );
    renderWithProviders(<ReceiptDuplicatesScreen />);
    await userEvent.click(await screen.findByRole('button', { name: t.nextPair }));
    expect(screen.getByText('another-purchase.jpg')).toBeInTheDocument();
    expect(screen.queryByText('fiscal.jpg')).not.toBeInTheDocument();
    expect(decisions).toBe(0);
    await userEvent.click(screen.getByRole('button', { name: t.nextPair }));
    expect(screen.getByText('fiscal.jpg')).toBeInTheDocument();
  });

  it('distinguishes scan failures from an empty result', async () => {
    server.use(
      http.get(ROOT, () =>
        HttpResponse.json({ error: { code: 'INTERNAL', message: 'Failure' } }, { status: 500 }),
      ),
    );
    renderWithProviders(<ReceiptDuplicatesScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent(enMessages.errors.codes.INTERNAL);
    expect(screen.queryByText(t.empty)).not.toBeInTheDocument();
  });
});
