import '@testing-library/jest-dom/vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { receiptApi } from '../../entities/receipt';
import { ReceiptsScreen } from './receipts-screen';

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';

const receipt: ReceiptListItemDto = {
  id: ID,
  fileName: 'email-receipt.jpg',
  mimeType: 'image/jpeg',
  ext: 'jpg',
  sizeBytes: '204800',
  pageCount: 1,
  previewStatus: 'DONE',
  extractionStatus: 'DONE',
  processing: false,
  extracted: {
    schema: { slug: 'receipt', version: 2 },
    values: {
      vendor: 'Voli Market',
      purchasedAt: '2026-09-08',
      purchasedTime: '17:42',
      total: { amount: 12.4, currency: 'EUR' },
    },
    confidence: 96,
  },
  processingError: null,
  createdAt: '2026-09-08T18:00:00.000Z',
  updatedAt: '2026-09-08T18:00:00.000Z',
  owner: { id: 'bbbbbbbb-2222-4222-8222-222222222222', displayName: 'Reader' },
};

const server = createApiMock();

function dragEvent(type: string, files: readonly File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files, dropEffect: 'none' },
  });
  return event;
}

function drag(event: Event): void {
  act(() => {
    window.dispatchEvent(event);
  });
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/receipts', () =>
      HttpResponse.json(envelope({ items: [receipt], nextCursor: null })),
    ),
    http.get(`/api/receipts/${ID}/thumbnail`, () =>
      HttpResponse.json(envelope({ url: 'https://storage.test/receipt-thumb.jpg' })),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('ReceiptsScreen', () => {
  it('shows receipt data in both responsive representations without document controls', async () => {
    const { container } = renderWithProviders(<ReceiptsScreen />);

    expect(
      await screen.findByRole('heading', { name: enMessages.receipts.title }),
    ).toBeInTheDocument();
    expect(await screen.findAllByText('Voli Market')).toHaveLength(2);
    expect(screen.getAllByText(/2026-09-08 · 17:42/)).toHaveLength(2);
    expect(screen.getAllByText(/12\.4 EUR/)).toHaveLength(2);
    expect(container.querySelector('.receipt-desktop-list')).not.toBeNull();
    expect(container.querySelector('.receipt-mobile-list')).not.toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('uploads every image dropped anywhere on the receipts page', async () => {
    const upload = vi.spyOn(receiptApi, 'upload').mockResolvedValue({ receipt, created: true });
    renderWithProviders(<ReceiptsScreen />);
    const files = [
      new File(['first'], 'first-receipt.jpg', { type: 'image/jpeg' }),
      new File(['second'], 'second-receipt.png', { type: 'image/png' }),
    ];

    drag(dragEvent('dragenter'));
    expect(screen.getByText(enMessages.receipts.dropHint)).toBeInTheDocument();

    drag(dragEvent('drop', files));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual(files.map((file) => file.name));
    expect(screen.queryByText(enMessages.receipts.dropHint)).not.toBeInTheDocument();
  });
});
