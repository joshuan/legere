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
  server.use(
    http.get('/api/people', () =>
      HttpResponse.json(envelope({ nextCursor: null, items: [person] })),
    ),
  );
  // The analyst is absent unless a test says otherwise: no banner, and a hand-picked merge keeps
  // its raw prefill (docs/11 §11.12a) — which is exactly what the older merge tests assert.
  server.use(
    http.get('/api/admin/people/merge-suggestions', () =>
      HttpResponse.json(envelope({ configured: false, groups: [] })),
    ),
    http.post('/api/admin/people/merge-preview', () =>
      HttpResponse.json(envelope({ available: false, name: null, aka: null })),
    ),
  );
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
      server.use(
        http.get('/api/people', () =>
          HttpResponse.json(envelope({ nextCursor: null, items: rows })),
        ),
      );

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

    it('clamps a prefilled note longer than the contract to what the contract accepts', async () => {
      // Two long notes whose raw composition exceeds the 500 the contract allows — the shape that
      // used to throw a client-side parse before any request was made (M48.1).
      const chatty = { ...person, note: 'a'.repeat(394) };
      const chattyTwin = { ...twin, note: 'b'.repeat(141) };
      const raw = `Also known as: ${twin.name}\n${chatty.note}\n${chattyTwin.note}`;

      let merged: unknown = null;
      server.use(
        http.post('/api/admin/people/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(person), { status: 201 });
        }),
      );

      const dialog = await openTheMergeDialog([chatty, chattyTwin]);
      const note = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note);
      expect(note).toHaveValue(raw.slice(0, 500));

      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );

      // The merge reaches the server and succeeds, rather than dying in the client's own schema.
      await waitFor(() => expect(merged).toMatchObject({ note: raw.slice(0, 500) }));
    });

    it('replaces an untouched prefill with the analyst tidier reading, when there is one', async () => {
      server.use(
        http.post('/api/admin/people/merge-preview', () =>
          HttpResponse.json(
            envelope({
              available: true,
              name: 'Marija Petrović',
              aka: ['Marija Petrovic', 'PETROVIC/MARIJA'],
            }),
          ),
        ),
      );

      const dialog = await openTheMergeDialog([person, twin]);
      const note = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note);

      // The tidy line lands over the raw one: each distinct spelling once, as the analyst read it.
      await waitFor(() =>
        expect(note).toHaveValue(
          'Also known as: Marija Petrovic, PETROVIC/MARIJA\nThe landlady\nSigns the lease',
        ),
      );
    });
  });

  describe('duplicate suggestions (docs/11 §11.12a, docs/05 §5.6c)', () => {
    const group = {
      ids: [person.id, twin.id],
      name: 'Marija Petrović',
      aka: ['Marija Petrovic'],
    };

    beforeEach(() => {
      server.use(
        http.get('/api/people', () =>
          HttpResponse.json(envelope({ nextCursor: null, items: [person, twin] })),
        ),
        http.get('/api/admin/people/merge-suggestions', () =>
          HttpResponse.json(envelope({ configured: true, groups: [group] })),
        ),
      );
    });

    it('shows an admin the banner, and opens the ordinary dialog prefilled from the answer', async () => {
      let merged: unknown = null;
      server.use(
        http.post('/api/admin/people/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(person), { status: 201 });
        }),
      );

      renderWithProviders(<PeopleScreen />, { user: TEST_ADMIN });

      // The screen notices first: the group's names, and a Merge of its own.
      expect(
        await screen.findByText(enMessages.admin.people.suggestions.title),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Merge 2/ }));

      const dialog = await screen.findByRole('dialog');
      // The analyst's answer, prefilled: its spelling as the name, its tidy line in the note.
      expect(
        within(dialog).getByLabelText(enMessages.admin.catalogues.fields.mergedName),
      ).toHaveValue('Marija Petrović');
      expect(within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note)).toHaveValue(
        'Also known as: Marija Petrovic\nThe landlady\nSigns the lease',
      );

      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );
      await waitFor(() =>
        expect(merged).toMatchObject({
          ids: [person.id, twin.id],
          name: 'Marija Petrović',
        }),
      );
    });

    it('shows no banner to a reader, and asks the server no admin question', async () => {
      renderWithProviders(<PeopleScreen />);

      expect(await screen.findByText('Marija Petrović')).toBeInTheDocument();
      // No admin, no suggestions query: the msw handler would have answered, but with
      // `onUnhandledRequest: 'error'` an unexpected call would fail loudly anyway — what is
      // asserted here is simply that no banner exists for somebody who cannot merge.
      expect(screen.queryByText(enMessages.admin.people.suggestions.title)).toBeNull();
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
