import '@testing-library/jest-dom/vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptListItemDto } from '../../../shared/contracts/receipts';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { receiptApi } from '../../entities/receipt';
import { ApiError } from '../../shared/api';
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
    schema: { slug: 'receipt', version: 3 },
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
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

  it('uploads a dropped batch sequentially and leaves its completed accounting on the page', async () => {
    const first = deferred<{ receipt: ReceiptListItemDto; created: boolean }>();
    const second = deferred<{ receipt: ReceiptListItemDto; created: boolean }>();
    const upload = vi
      .spyOn(receiptApi, 'upload')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    renderWithProviders(<ReceiptsScreen />);
    const files = [
      new File(['first'], 'first-receipt.jpg', { type: 'image/jpeg' }),
      new File(['second'], 'second-receipt.png', { type: 'image/png' }),
    ];

    drag(dragEvent('dragenter'));
    expect(screen.getByText(enMessages.receipts.dropHint)).toBeInTheDocument();

    drag(dragEvent('drop', files));

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Uploading 1 of 2')).toBeInTheDocument();

    act(() => first.resolve({ receipt, created: true }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Uploading 2 of 2')).toBeInTheDocument();

    act(() => second.resolve({ receipt, created: true }));
    expect(await screen.findByText('Uploaded 2 of 2')).toBeInTheDocument();
    expect(upload.mock.calls.map(([file]) => file.name)).toEqual(files.map((file) => file.name));
    expect(screen.queryByText(enMessages.receipts.dropHint)).not.toBeInTheDocument();
    expect(screen.queryByText('Receipt uploaded')).not.toBeInTheDocument();

    // The result is a persistent record, dismissed only by the reader.
    await act(async () => Promise.resolve());
    expect(screen.getByText('Uploaded 2 of 2')).toBeInTheDocument();
    expect(document.querySelector('.ant-message-notice')).toBeNull();
  });

  it('toasts only an error and keeps that failed file and batch total visible', async () => {
    vi.spyOn(receiptApi, 'upload').mockRejectedValue(new ApiError('INTERNAL', 500));
    renderWithProviders(<ReceiptsScreen />);

    drag(
      dragEvent('drop', [new File(['broken'], 'unreadable-receipt.jpg', { type: 'image/jpeg' })]),
    );

    expect(await screen.findByText('Uploaded 0 of 1')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: enMessages.receipts.uploadBatch.label });
    expect(within(panel).getByText(enMessages.receipts.uploadBatch.errors)).toBeInTheDocument();
    expect(within(panel).getByText(/unreadable-receipt\.jpg/)).toHaveTextContent(
      enMessages.errors.codes.INTERNAL,
    );
    await waitFor(() =>
      expect(document.querySelector('.ant-message')).toHaveTextContent(
        `unreadable-receipt.jpg: ${enMessages.errors.codes.INTERNAL}`,
      ),
    );
  });
});
