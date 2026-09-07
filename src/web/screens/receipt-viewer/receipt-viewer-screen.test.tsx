import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptDetailDto } from '../../../shared/contracts/receipts';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { ReceiptViewerScreen } from './receipt-viewer-screen';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const SOURCE_TEXT = '<html>Email footer and unformatted order text</html>';

const receipt: ReceiptDetailDto = {
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
      items: [{ name: 'Coffee', quantity: 1, unitPrice: 4.2, amount: 4.2 }],
    },
    confidence: 96,
  },
  processingError: null,
  createdAt: '2026-09-08T18:00:00.000Z',
  updatedAt: '2026-09-08T18:00:00.000Z',
  lastEventAt: '2026-09-08T18:00:00.000Z',
  sourceText: SOURCE_TEXT,
  owner: { id: 'bbbbbbbb-2222-4222-8222-222222222222', displayName: 'Reader' },
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get(`/api/receipts/${ID}`, () => HttpResponse.json(envelope(receipt))),
    http.get(`/api/receipts/${ID}/original`, () =>
      HttpResponse.json(envelope({ url: 'https://storage.test/email-receipt.jpg' })),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('ReceiptViewerScreen', () => {
  it('shows the image, structured fields and item rows, with source text behind a disclosure', async () => {
    const { container } = renderWithProviders(<ReceiptViewerScreen id={ID} />);

    expect(await screen.findByRole('heading', { name: 'Voli Market' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        container.querySelector('img[src="https://storage.test/email-receipt.jpg"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText('Coffee')).toBeInTheDocument();
    expect(screen.getByText('12.4 EUR')).toBeInTheDocument();
    expect(screen.getAllByText(enMessages.receipts.statuses.DONE)).toHaveLength(2);

    expect(screen.queryByText(SOURCE_TEXT)).toBeNull();
    await userEvent.click(screen.getByText(enMessages.receipts.sourceText));
    expect(await screen.findByText(SOURCE_TEXT)).toBeInTheDocument();
  });
});
