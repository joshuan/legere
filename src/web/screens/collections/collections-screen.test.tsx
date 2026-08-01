import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { CollectionsScreen } from './collections-screen';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const mine = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Taxes',
  description: 'Yearly paperwork.',
  ownerId: 'cccccccc-3333-4333-8333-333333333333',
  ownerName: 'Me',
  mine: true,
  sharedByMe: true,
  sharedWithMe: false,
  itemCount: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const theirs = {
  ...mine,
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Household',
  ownerName: 'Alice',
  mine: false,
  sharedByMe: false,
  sharedWithMe: true,
  itemCount: 2,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/collections', () => HttpResponse.json(envelope({ items: [mine, theirs] }))),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('CollectionsScreen', () => {
  it('separates my collections from the ones shared with me, naming their owner', async () => {
    renderWithProviders(<CollectionsScreen />);

    // The cards render before their data arrives; wait for the content itself.
    await screen.findByText('Taxes');
    const mineCard = screen.getByText(enMessages.collections.mine).closest('.ant-card');
    const sharedCard = screen.getByText(enMessages.collections.sharedWithMe).closest('.ant-card');
    if (!(mineCard instanceof HTMLElement) || !(sharedCard instanceof HTMLElement)) {
      throw new Error('expected both groups');
    }

    expect(within(mineCard).getByText('Taxes')).toBeInTheDocument();
    expect(within(sharedCard).getByText('Household')).toBeInTheDocument();
    // Whose collection it is matters when it is not yours.
    expect(within(sharedCard).getByText('Alice')).toBeInTheDocument();
    expect(within(mineCard).getByText(enMessages.collections.sharedByMe)).toBeInTheDocument();
  });

  it('creates a collection', async () => {
    let created: unknown = null;
    server.use(
      http.post('/api/collections', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(envelope(mine), { status: 201 });
      }),
    );

    renderWithProviders(<CollectionsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.collections.actions.create }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.collections.fields.name),
      'Receipts',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    await waitFor(() => expect(created).toEqual({ name: 'Receipts', description: null }));
  });

  it('reports a name the owner already used', async () => {
    server.use(
      http.post('/api/collections', () =>
        HttpResponse.json(errorEnvelope('COLLECTION_NAME_TAKEN'), { status: 409 }),
      ),
    );

    renderWithProviders(<CollectionsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.collections.actions.create }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.collections.fields.name),
      'Taxes',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    expect(
      await screen.findByText(enMessages.errors.codes.COLLECTION_NAME_TAKEN),
    ).toBeInTheDocument();
  });

  it('says plainly when a group is empty', async () => {
    server.use(http.get('/api/collections', () => HttpResponse.json(envelope({ items: [] }))));

    renderWithProviders(<CollectionsScreen />);

    expect(await screen.findByText(enMessages.collections.emptyMine)).toBeInTheDocument();
    expect(screen.getByText(enMessages.collections.emptyShared)).toBeInTheDocument();
  });
});
