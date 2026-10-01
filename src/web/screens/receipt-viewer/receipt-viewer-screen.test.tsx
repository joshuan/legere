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
    schema: { slug: 'receipt', version: 3 },
    values: {
      vendor: 'Voli Market',
      vendorAddress: 'Bulevar Revolucije 5, 85000 Bar',
      country: 'ME',
      city: 'Bar',
      purchasedAt: '2026-09-08',
      purchasedTime: '17:42',
      total: { amount: 12.4, currency: 'EUR' },
      items: [
        {
          name: 'Coffee',
          quantity: 1,
          unitPrice: 4.2,
          amount: 4.2,
          taxCode: 'A',
          taxRate: 21,
          taxAmount: 0.73,
        },
      ],
    },
    confidence: 96,
  },
  processingError: null,
  createdAt: '2026-09-08T18:00:00.000Z',
  updatedAt: '2026-09-08T18:00:00.000Z',
  lastEventAt: '2026-09-08T18:00:00.000Z',
  sourceText: SOURCE_TEXT,
  reference: { state: 'ACTIVE', replacementId: null, restoredReceiptIds: [], reviewId: null },
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
    expect(screen.getByText('Bulevar Revolucije 5, 85000 Bar')).toBeInTheDocument();
    expect(screen.getByText('ME')).toBeInTheDocument();
    expect(screen.getByText('Bar')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('21')).toBeInTheDocument();
    expect(screen.getByText('0.73')).toBeInTheDocument();
    expect(screen.getByText('12.4 EUR')).toBeInTheDocument();
    expect(screen.getAllByText(enMessages.receipts.statuses.DONE)).toHaveLength(2);

    expect(screen.queryByText(SOURCE_TEXT)).toBeNull();
    await userEvent.click(screen.getByText(enMessages.receipts.sourceText));
    expect(await screen.findByText(SOURCE_TEXT)).toBeInTheDocument();
  });
  it.each(['REPLACED', 'MERGE_UNDONE'] as const)(
    'keeps the original visible and explains %s with related links',
    async (state) => {
      const related = '33333333-3333-4333-8333-333333333333';
      server.use(
        http.get(`/api/receipts/${ID}`, () =>
          HttpResponse.json(
            envelope({
              ...receipt,
              reference: {
                state,
                replacementId: state === 'REPLACED' ? related : null,
                restoredReceiptIds: state === 'MERGE_UNDONE' ? [related] : [],
                reviewId: '44444444-4444-4444-8444-444444444444',
              },
            }),
          ),
        ),
      );
      renderWithProviders(<ReceiptViewerScreen id={ID} />);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        enMessages.receipts.reference.preserved,
      );
      const link = screen.getByRole('link', {
        name:
          state === 'REPLACED'
            ? enMessages.receipts.reference.openReplacement
            : enMessages.receipts.reference.openSource.replace('{side}', '1'),
      });
      expect(link).toHaveAttribute('href', `/receipts/${related}`);
      expect(screen.getByRole('button', { name: enMessages.receipts.delete })).toBeDisabled();
      expect(
        screen.getByRole('button', { name: enMessages.receipts.moveToDocuments }),
      ).toBeDisabled();
      expect(
        screen.getByRole('button', { name: enMessages.receipts.downloadOriginal }),
      ).toBeEnabled();
      expect(screen.getByText('Coffee')).toBeInTheDocument();
    },
  );

  it('recovers a failed receipt read through the inline retry action', async () => {
    let failing = true;
    server.use(
      http.get(`/api/receipts/${ID}`, () =>
        failing
          ? HttpResponse.json({ error: null }, { status: 500 })
          : HttpResponse.json(envelope(receipt)),
      ),
    );
    renderWithProviders(<ReceiptViewerScreen id={ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(enMessages.errors.codes.INTERNAL);
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: enMessages.common.actions.retry }));
    expect(await screen.findByRole('heading', { name: 'Voli Market' })).toBeInTheDocument();
  });

  it('makes a failed original image request retryable', async () => {
    server.use(
      http.get(`/api/receipts/${ID}/original`, () =>
        HttpResponse.json({ error: null }, { status: 500 }),
      ),
    );
    renderWithProviders(<ReceiptViewerScreen id={ID} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(enMessages.errors.codes.INTERNAL);
    expect(
      screen.getByRole('button', { name: enMessages.common.actions.retry }),
    ).toBeInTheDocument();
  });

  it('reports unavailable clipboard access without an unhandled rejection', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Permission denied'));
    renderWithProviders(<ReceiptViewerScreen id={ID} />);
    await user.click(await screen.findByRole('button', { name: enMessages.receipts.copyJson }));
    expect(await screen.findByText(enMessages.receipts.copyFailed)).toBeInTheDocument();
  });
});
