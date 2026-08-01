import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { CollectionDetailScreen } from './collection-detail-screen';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const OWNER_ID = 'cccccccc-3333-4333-8333-333333333333';
const OTHER_ID = 'dddddddd-4444-4444-8444-444444444444';
const ID = 'aaaaaaaa-1111-4111-8111-111111111111';

const document1 = {
  id: 'eeeeeeee-5555-4555-8555-555555555555',
  title: 'Rental agreement',
  ext: 'pdf',
  mimeType: 'application/pdf',
  sizeBytes: '2048',
  pageCount: 1,
  category: null,
  availability: 'AVAILABLE',
  processing: false,
  source: 'LIBRARY',
  hasPreview: false,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const detail = {
  collection: {
    id: ID,
    name: 'Taxes',
    description: 'Yearly paperwork.',
    ownerId: OWNER_ID,
    ownerName: 'Alice',
    mine: true,
    sharedByMe: false,
    sharedWithMe: false,
    itemCount: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  items: { items: [document1], nextCursor: null },
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get(`/api/collections/${ID}`, () => HttpResponse.json(envelope(detail))),
    http.get(`/api/collections/${ID}/shares`, () =>
      HttpResponse.json(envelope({ items: [] })),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('CollectionDetailScreen', () => {
  it('shows the documents the viewer may see', async () => {
    renderWithProviders(<CollectionDetailScreen id={ID} currentUserId={OWNER_ID} />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
  });

  it('offers no edit affordances to somebody who is not the owner', async () => {
    renderWithProviders(<CollectionDetailScreen id={ID} currentUserId={OTHER_ID} />);

    expect(await screen.findByText('Rental agreement')).toBeInTheDocument();
    // The API would refuse them anyway; offering them would be a lie (docs/11 §11.7).
    expect(
      screen.queryByRole('button', { name: enMessages.collections.actions.share }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: enMessages.collections.actions.remove }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Owned by Alice/)).toBeInTheDocument();
  });

  it('removes a document after confirming, naming it', async () => {
    let removed = false;
    server.use(
      http.delete(`/api/collections/${ID}/items/${document1.id}`, () => {
        removed = true;
        return HttpResponse.json(envelope({ ok: true }));
      }),
    );

    renderWithProviders(<CollectionDetailScreen id={ID} currentUserId={OWNER_ID} />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.collections.actions.remove }),
    );

    expect(await screen.findByText(/Remove “Rental agreement”/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: enMessages.common.yes }));

    await waitFor(() => expect(removed).toBe(true));
  });

  it('shares with a person found through the lookup', async () => {
    let shared: unknown = null;
    server.use(
      http.get('/api/users/lookup', () =>
        HttpResponse.json(
          envelope([{ id: OTHER_ID, displayName: 'Bob', email: 'bob@legere.local' }]),
        ),
      ),
      http.post(`/api/collections/${ID}/shares`, async ({ request }) => {
        shared = await request.json();
        return HttpResponse.json(
          envelope({
            id: 'ffffffff-6666-4666-8666-666666666666',
            granteeUserId: OTHER_ID,
            granteeName: 'Bob',
            createdAt: '2026-01-02T00:00:00.000Z',
          }),
        );
      }),
    );

    renderWithProviders(<CollectionDetailScreen id={ID} currentUserId={OWNER_ID} />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.collections.actions.share }),
    );
    await userEvent.type(
      await screen.findByRole('combobox', { name: enMessages.collections.share.findPerson }),
      'bob',
    );
    await userEvent.click(await screen.findByTitle(/Bob/));

    await waitFor(() => expect(shared).toEqual({ granteeUserId: OTHER_ID }));
  });

  it('opens the collection to the whole instance with one switch', async () => {
    let shared: unknown = null;
    server.use(
      http.post(`/api/collections/${ID}/shares`, async ({ request }) => {
        shared = await request.json();
        return HttpResponse.json(
          envelope({
            id: 'ffffffff-6666-4666-8666-666666666666',
            granteeUserId: null,
            granteeName: null,
            createdAt: '2026-01-02T00:00:00.000Z',
          }),
        );
      }),
    );

    renderWithProviders(<CollectionDetailScreen id={ID} currentUserId={OWNER_ID} />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.collections.actions.share }),
    );
    await userEvent.click(
      await screen.findByRole('switch', { name: enMessages.collections.share.everyone }),
    );

    await waitFor(() => expect(shared).toEqual({ granteeUserId: null }));
  });
});
