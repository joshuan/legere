import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminPeopleScreen } from './admin-people-screen';

const person = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Marija Petrović',
  note: 'The landlady',
  documentCount: 40,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(http.get('/api/people', () => HttpResponse.json(envelope({ items: [person] }))));
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminPeopleScreen', () => {
  it('shows the catalogue with what tells two people apart', async () => {
    renderWithProviders(<AdminPeopleScreen />);

    expect(await screen.findByText('Marija Petrović')).toBeInTheDocument();
    expect(screen.getByText('The landlady')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('corrects a spelling once, for every document that names them', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/admin/people/${person.id}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...person, name: 'Marija Petrovic' }));
      }),
    );

    renderWithProviders(<AdminPeopleScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );

    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.name);
    await userEvent.clear(name);
    await userEvent.type(name, 'Marija Petrovic');
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    // One row, not forty edits — the reason the catalogue exists (docs/03 §3.3.19).
    await waitFor(() => expect(patched).toMatchObject({ name: 'Marija Petrovic' }));
  });
});
