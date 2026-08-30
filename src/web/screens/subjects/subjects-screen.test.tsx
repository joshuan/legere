import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { SubjectsScreen } from './subjects-screen';

const APARTMENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOAT = 'bbbbbbbb-2222-4222-8222-222222222222';

// The screen reads the kind filter out of its URL (docs/11 §11.12a): the kinds screen's things
// count links here already narrowed.
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

const subject = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  kindId: APARTMENT,
  kind: 'apartment',
  name: 'Njegoševa 5',
  note: null,
  documentCount: 4,
  lastDocumentAt: '2026-03-01',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  currentSearch = '';
  // The analyst is absent unless a test says otherwise: no banner, and a hand-picked merge keeps
  // its raw prefill (docs/11 §11.12a).
  server.use(
    http.get('/api/admin/subjects/merge-suggestions', () =>
      HttpResponse.json(
        envelope({ state: 'UNCONFIGURED', computedAt: null, groups: [], placeholders: [] }),
      ),
    ),
    http.post('/api/admin/subjects/merge-preview', () =>
      HttpResponse.json(
        envelope({ available: false, name: null, kindId: null, aka: null, note: null }),
      ),
    ),
    http.get('/api/subjects', () =>
      HttpResponse.json(envelope({ nextCursor: null, items: [subject] })),
    ),
    http.get('/api/subject-kinds', () =>
      HttpResponse.json(
        envelope({
          nextCursor: null,
          items: [
            {
              id: APARTMENT,
              name: 'apartment',
              note: null,
              subjectCount: 1,
              documentCount: 4,
              lastDocumentAt: '2026-03-01',
            },
            {
              id: BOAT,
              name: 'boat',
              note: null,
              subjectCount: 0,
              documentCount: 0,
              lastDocumentAt: null,
            },
          ],
        }),
      ),
    ),
  );
});
afterEach(() => {
  // The panel's fold lasts the tab (docs/11 §11.12a), so it must not last past a test.
  window.sessionStorage.clear();
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('SubjectsScreen', () => {
  it('shows both halves of a thing and how many documents it is on', async () => {
    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });

    expect(await screen.findByText('Njegoševa 5')).toBeInTheDocument();
    expect(screen.getByText('apartment')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('moves a thing to another kind, without deleting and retyping it', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/admin/subjects/${subject.id}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...subject, kindId: BOAT, kind: 'boat' }));
      }),
    );

    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );

    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByLabelText(enMessages.admin.subjects.fields.kind));
    await userEvent.click(await screen.findByTitle('boat'));
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    await waitFor(() =>
      expect(patched).toMatchObject({ kindId: BOAT, name: 'Njegoševa 5', note: null }),
    );
  });

  it('folds the selected rows into one, asking which name is the right one', async () => {
    let merged: unknown = null;
    server.use(
      http.post('/api/admin/subjects/merge', async ({ request }) => {
        merged = await request.json();
        return HttpResponse.json(envelope(subject), { status: 201 });
      }),
      http.get('/api/subjects', () =>
        HttpResponse.json(
          envelope({
            nextCursor: null,
            items: [
              subject,
              { ...subject, id: 'dddddddd-4444-4444-8444-444444444444', name: 'the flat' },
            ],
          }),
        ),
      ),
    );

    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
    await screen.findByText('the flat');
    // The header checkbox takes both rows; a merge of one row is not a merge.
    const [selectAll] = screen.getAllByRole('checkbox');
    if (selectAll === undefined) throw new Error('expected a selection checkbox');
    await userEvent.click(selectAll);
    await userEvent.click(await screen.findByRole('button', { name: /Merge 2/ }));

    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.mergedName);
    await userEvent.clear(name);
    await userEvent.type(name, 'Njegoševa 5');
    await userEvent.click(
      within(dialog).getByRole('button', {
        name: enMessages.admin.catalogues.actions.mergeConfirm,
      }),
    );

    await waitFor(() =>
      expect(merged).toMatchObject({
        ids: [subject.id, 'dddddddd-4444-4444-8444-444444444444'],
        name: 'Njegoševa 5',
        kindId: APARTMENT,
        // The name that is about to disappear is kept as a note rather than lost: it is how this
        // flat was written on the documents that named it (docs/11 §11.12a).
        note: 'Also known as: the flat',
      }),
    );
  });

  it('clamps a prefilled note longer than the contract to what the contract accepts', async () => {
    // Notes whose raw composition exceeds the 2000 the subjects contract allows — the same
    // prefill-overflow the people dialog had (M48.1), on the other catalogue that merges.
    const chatty = { ...subject, note: 'a'.repeat(1500) };
    const chattyTwin = {
      ...subject,
      id: 'dddddddd-4444-4444-8444-444444444444',
      name: 'the flat',
      note: 'b'.repeat(600),
    };
    const raw = `Also known as: the flat\n${chatty.note}\n${chattyTwin.note}`;

    let merged: unknown = null;
    server.use(
      http.post('/api/admin/subjects/merge', async ({ request }) => {
        merged = await request.json();
        return HttpResponse.json(envelope(subject), { status: 201 });
      }),
      http.get('/api/subjects', () =>
        HttpResponse.json(envelope({ nextCursor: null, items: [chatty, chattyTwin] })),
      ),
    );

    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
    await screen.findByText('the flat');
    const [selectAll] = screen.getAllByRole('checkbox');
    if (selectAll === undefined) throw new Error('expected a selection checkbox');
    await userEvent.click(selectAll);
    await userEvent.click(await screen.findByRole('button', { name: /Merge 2/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note)).toHaveValue(
      raw.slice(0, 2000),
    );

    await userEvent.click(
      within(dialog).getByRole('button', {
        name: enMessages.admin.catalogues.actions.mergeConfirm,
      }),
    );
    await waitFor(() => expect(merged).toMatchObject({ note: raw.slice(0, 2000) }));
  });

  it('opens the create dialog focused on the name, not the kind above it (docs/11 §11.14)', async () => {
    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.subjects.actions.create }),
    );

    // The name field, even where a select stands before it in the form.
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.name);
    await waitFor(() => expect(name).toHaveFocus());
  });

  it('honours the kind filter arriving in its URL (docs/11 §11.12a)', async () => {
    currentSearch = `kindId=${BOAT}`;
    server.use(
      http.get('/api/subjects', () =>
        HttpResponse.json(
          envelope({
            nextCursor: null,
            items: [
              subject,
              {
                ...subject,
                id: 'dddddddd-4444-4444-8444-444444444444',
                kindId: BOAT,
                kind: 'boat',
                name: 'Sea Fox',
              },
            ],
          }),
        ),
      ),
    );

    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });

    // Only the boat: a link that dropped its filter on arrival would be a link that does not work.
    expect(await screen.findByText('Sea Fox')).toBeInTheDocument();
    expect(screen.queryByText('Njegoševa 5')).toBeNull();
  });

  it('stands its actions at the foot of the screen (docs/11 §11.12a)', async () => {
    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
    await screen.findByText('Njegoševa 5');

    const bar = screen.getByRole('toolbar', { name: enMessages.admin.catalogues.actionsBar });
    expect(
      within(bar).getByRole('button', { name: enMessages.admin.subjects.actions.create }),
    ).toBeInTheDocument();
    // Sticky and in flow, not a fixed overlay: the table ends above the bar rather than under it.
    expect(bar).toHaveStyle({ position: 'sticky' });
  });

  it('says a delete leaves the documents alone rather than implying they change', async () => {
    renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.delete }),
    );

    // The confirmation carries the count, because "delete this" and "delete this from four
    // documents" are different questions (docs/11 §11.12a).
    expect(await screen.findByText(/stays on the 4 documents/)).toBeInTheDocument();
  });

  describe('duplicate suggestions (docs/11 §11.12a, docs/05 §5.6c)', () => {
    const twin = {
      ...subject,
      id: 'dddddddd-4444-4444-8444-444444444444',
      kindId: BOAT,
      kind: 'boat',
      name: 'NJEGOSEVA 5',
    };
    const placeholder = {
      ...subject,
      id: 'eeeeeeee-5555-4555-8555-555555555555',
      name: 'apartment',
      documentCount: 0,
    };

    beforeEach(() => {
      server.use(
        http.get('/api/subjects', () =>
          HttpResponse.json(envelope({ nextCursor: null, items: [subject, twin, placeholder] })),
        ),
        http.get('/api/admin/subjects/merge-suggestions', () =>
          HttpResponse.json(
            envelope({
              state: 'ANSWERED',
              computedAt: '2026-08-30T10:00:00.000Z',
              groups: [
                {
                  ids: [subject.id, twin.id],
                  name: 'Njegoševa 5',
                  kindId: APARTMENT,
                  aka: ['NJEGOSEVA 5'],
                  note: null,
                },
              ],
              placeholders: [placeholder.id],
            }),
          ),
        ),
      );
    });

    it('opens the dialog with the analyst name and kind, across two kinds', async () => {
      let merged: unknown = null;
      server.use(
        http.post('/api/admin/subjects/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(subject), { status: 201 });
        }),
      );

      renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
      expect(
        await screen.findByText(enMessages.admin.subjects.suggestions.title),
      ).toBeInTheDocument();
      // The group names both halves, because the duplicate sits across two kinds.
      expect(screen.getByText('apartment: Njegoševa 5, boat: NJEGOSEVA 5')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Merge 2/ }));

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByLabelText(enMessages.admin.catalogues.fields.mergedName),
      ).toHaveValue('Njegoševa 5');
      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );
      await waitFor(() =>
        expect(merged).toMatchObject({
          ids: [subject.id, twin.id],
          name: 'Njegoševa 5',
          kindId: APARTMENT,
          note: 'Also known as: NJEGOSEVA 5',
        }),
      );
    });

    it('offers the placeholder rows for deletion, one confirmed row at a time', async () => {
      let deleted: string | null = null;
      server.use(
        http.delete(`/api/admin/subjects/${placeholder.id}`, () => {
          deleted = placeholder.id;
          return HttpResponse.json(envelope({ ok: true }));
        }),
      );

      renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });
      expect(
        await screen.findByText(enMessages.admin.subjects.suggestions.placeholdersTitle),
      ).toBeInTheDocument();
      expect(screen.getByText('apartment: apartment')).toBeInTheDocument();

      // The banner's delete, behind the same confirmation as the table's.
      const [bannerDelete] = screen.getAllByRole('button', {
        name: enMessages.common.actions.delete,
      });
      if (bannerDelete === undefined) throw new Error('expected a delete button in the banner');
      await userEvent.click(bannerDelete);
      await userEvent.click(await screen.findByRole('button', { name: enMessages.common.yes }));

      await waitFor(() => expect(deleted).toBe(placeholder.id));
    });

    it('says the analyst could not be asked, instead of showing nothing', async () => {
      server.use(
        http.get('/api/admin/subjects/merge-suggestions', () =>
          HttpResponse.json(
            envelope({ state: 'UNAVAILABLE', computedAt: null, groups: [], placeholders: [] }),
          ),
        ),
      );

      renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });

      expect(
        await screen.findByText(enMessages.admin.catalogues.suggestions.unavailable),
      ).toBeInTheDocument();
      // Neither half of the ordinary panel: no groups, and no placeholder list either.
      expect(screen.queryByText(enMessages.admin.subjects.suggestions.title)).toBeNull();
      expect(
        screen.queryByText(enMessages.admin.subjects.suggestions.placeholdersTitle),
      ).toBeNull();
    });

    it('folds the groups and the placeholders together, keeping the count (M56.7)', async () => {
      renderWithProviders(<SubjectsScreen />, { user: TEST_ADMIN });

      expect(await screen.findByText(/1 possible duplicate group/)).toBeInTheDocument();
      expect(
        screen.getByText(enMessages.admin.subjects.suggestions.placeholdersTitle),
      ).toBeInTheDocument();

      await userEvent.click(
        screen.getByRole('button', { name: enMessages.admin.catalogues.suggestions.fold }),
      );

      // The line stays and counts; both halves of the unfolded panel go.
      expect(screen.getByText(/1 possible duplicate group/)).toBeInTheDocument();
      expect(screen.queryByText(enMessages.admin.subjects.suggestions.title)).toBeNull();
      expect(
        screen.queryByText(enMessages.admin.subjects.suggestions.placeholdersTitle),
      ).toBeNull();
    });
  });
});
