import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { PeopleScreen } from './people-screen';

const person = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'Marija Petrović',
  note: 'The landlady',
  documentCount: 40,
};

// The same person, as another document spells her (docs/03 §3.3.19).
const twin = {
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'Marija Petrovic',
  note: 'Signs the lease',
  documentCount: 3,
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

describe('PeopleScreen', () => {
  it('shows the catalogue with what tells two people apart', async () => {
    renderWithProviders(<PeopleScreen />, { user: TEST_ADMIN });

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

    renderWithProviders(<PeopleScreen />, { user: TEST_ADMIN });
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

  describe('merging (docs/11 §11.12a)', () => {
    async function openTheMergeDialog(rows: unknown[]): Promise<HTMLElement> {
      server.use(http.get('/api/people', () => HttpResponse.json(envelope({ items: rows }))));

      renderWithProviders(<PeopleScreen />, { user: TEST_ADMIN });
      // All of them, because two rows may well be spelled the same.
      await screen.findAllByText(/Marija Petrovi/);
      // The header checkbox takes every row; a merge of one row is not a merge.
      const [selectAll] = screen.getAllByRole('checkbox');
      if (selectAll === undefined) throw new Error('expected a selection checkbox');
      await userEvent.click(selectAll);
      await userEvent.click(await screen.findByRole('button', { name: /Merge 2/ }));

      return await screen.findByRole('dialog');
    }

    it('keeps every line the merged rows carried, and sends what is left of it', async () => {
      let merged: unknown = null;
      server.use(
        http.post('/api/admin/people/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(person), { status: 201 });
        }),
      );

      const dialog = await openTheMergeDialog([person, twin]);
      const note = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note);

      // The name that is about to disappear, then every note any of the rows had: the default is
      // "keep everything", because the alternative is a merge that quietly destroys the one line
      // somebody wrote a year ago.
      expect(note).toHaveValue('Also known as: Marija Petrovic\nThe landlady\nSigns the lease');

      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );

      await waitFor(() =>
        expect(merged).toMatchObject({
          ids: [person.id, twin.id],
          name: person.name,
          note: 'Also known as: Marija Petrovic\nThe landlady\nSigns the lease',
        }),
      );
    });

    it('lets the note be edited before the merge is confirmed', async () => {
      let merged: unknown = null;
      server.use(
        http.post('/api/admin/people/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(person), { status: 201 });
        }),
      );

      const dialog = await openTheMergeDialog([person, twin]);
      const note = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note);
      await userEvent.clear(note);
      await userEvent.type(note, 'The landlady');
      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );

      // An ordinary field: a person deletes what is noise and keeps what is not.
      await waitFor(() => expect(merged).toMatchObject({ note: 'The landlady' }));
    });

    it('leaves the note empty when the rows carried nothing to keep', async () => {
      const dialog = await openTheMergeDialog([
        { ...person, note: null },
        { ...twin, name: person.name, note: null },
      ]);

      expect(within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note)).toHaveValue(
        '',
      );
    });
  });

  it('shows the catalogue to anyone, and offers the corrections to an admin only', async () => {
    renderWithProviders(<PeopleScreen />);

    // Reading it is everybody's: a name on a document is content, not administration
    // (docs/11 §11.12a).
    expect(await screen.findByText('Marija Petrović')).toBeInTheDocument();
    // Adding is open too — the analysis does it, and whoever corrects it must be able to.
    expect(
      screen.getByRole('button', { name: enMessages.admin.people.actions.create }),
    ).toBeInTheDocument();
    // 🔒 Renaming and deleting reach across every document that names them (docs/03 §3.3.19).
    expect(screen.queryByRole('button', { name: enMessages.common.actions.edit })).toBeNull();
    expect(screen.queryByRole('button', { name: enMessages.common.actions.delete })).toBeNull();
  });
});
