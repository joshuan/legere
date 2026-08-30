import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { SubjectKindsScreen } from './subject-kinds-screen';

const kind = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'apartment',
  note: null,
  subjectCount: 3,
  documentCount: 11,
  lastDocumentAt: '2026-03-01',
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  // The analyst is absent unless a test says otherwise (docs/11 §11.12a).
  server.use(
    http.get('/api/subject-kinds', () =>
      HttpResponse.json(envelope({ nextCursor: null, items: [kind] })),
    ),
    http.get('/api/admin/subject-kinds/merge-suggestions', () =>
      HttpResponse.json(envelope({ state: 'UNCONFIGURED', computedAt: null, groups: [] })),
    ),
    http.post('/api/admin/subject-kinds/merge-preview', () =>
      HttpResponse.json(envelope({ available: false, name: null, aka: null, note: null })),
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

describe('SubjectKindsScreen', () => {
  it('shows what hangs off a kind, which is what it is worth keeping for', async () => {
    renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });

    expect(await screen.findByText('apartment')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('11')).toBeInTheDocument();
  });

  it('renames a kind, which is the whole reason kinds are a catalogue', async () => {
    let patched: unknown = null;
    server.use(
      http.patch(`/api/admin/subject-kinds/${kind.id}`, async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...kind, name: 'flat' }));
      }),
    );

    renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );

    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(enMessages.admin.catalogues.fields.name);
    await userEvent.clear(name);
    await userEvent.type(name, 'flat');
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    await waitFor(() => expect(patched).toMatchObject({ name: 'flat' }));
  });

  it('sorts by the things count on the server, the name this list alone knows (docs/07 §7.3)', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/subject-kinds', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ nextCursor: null, items: [kind] }));
      }),
    );

    renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });

    expect(await screen.findByText('2026-03-01')).toBeInTheDocument();
    expect(seen[0]).toContain('sort=lastDocumentAt');

    await userEvent.click(screen.getByText(enMessages.admin.subjectKinds.columns.subjects));
    await waitFor(() => expect(seen.length).toBeGreaterThan(1));
    // `things` is the kinds list's own sort name — the other two catalogues do not have it.
    expect(seen[seen.length - 1]).toContain('sort=things');
  });

  it('turns its counts into doors, zero staying plain text (docs/11 §11.12a)', async () => {
    server.use(
      http.get('/api/subject-kinds', () =>
        HttpResponse.json(
          envelope({
            nextCursor: null,
            items: [
              kind,
              {
                id: 'cccccccc-3333-4333-8333-333333333333',
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

    renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });

    // The things count answers "which three?" on /subjects, filtered to this kind…
    const things = await screen.findByRole('link', { name: '3' });
    expect(things).toHaveAttribute('href', `/subjects?kindId=${kind.id}`);
    // …and the documents count on the browse, by the filter the API already has (docs/07 §7.3).
    const documents = screen.getByRole('link', { name: '11' });
    expect(documents).toHaveAttribute('href', `/documents?subjectKindId=${kind.id}`);
    // A count of zero is a door to nowhere, so it is not one.
    expect(screen.queryByRole('link', { name: '0' })).toBeNull();
  });

  it('stands its actions at the foot of the screen (docs/11 §11.12a)', async () => {
    renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });
    await screen.findByText('apartment');

    const bar = screen.getByRole('toolbar', { name: enMessages.admin.catalogues.actionsBar });
    expect(
      within(bar).getByRole('button', { name: enMessages.admin.subjectKinds.actions.create }),
    ).toBeInTheDocument();
    // Sticky and in flow, not a fixed overlay: the table ends above the bar rather than under it.
    expect(bar).toHaveStyle({ position: 'sticky' });
  });

  it('says a kind still holding things cannot simply be deleted', async () => {
    renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.delete }),
    );

    // 🔒 The server refuses this one (SUBJECT_KIND_IN_USE), so the confirmation says why rather than
    // offering a button that cannot work (docs/03 §3.3.20a).
    expect(await screen.findByText(/still holds 3 things/)).toBeInTheDocument();
  });

  describe('merging (docs/03 §3.3.20a, docs/11 §11.12a)', () => {
    const twin = {
      id: 'bbbbbbbb-2222-4222-8222-222222222222',
      name: 'Apartment',
      note: null,
      subjectCount: 1,
      documentCount: 2,
      lastDocumentAt: null,
    };

    it('folds the selected kinds into one, asking which name is the right one', async () => {
      let merged: unknown = null;
      server.use(
        http.get('/api/subject-kinds', () =>
          HttpResponse.json(envelope({ nextCursor: null, items: [kind, twin] })),
        ),
        http.post('/api/admin/subject-kinds/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(kind), { status: 201 });
        }),
      );

      renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });
      await screen.findByText('Apartment');
      const [selectAll] = screen.getAllByRole('checkbox');
      if (selectAll === undefined) throw new Error('expected a selection checkbox');
      await userEvent.click(selectAll);
      await userEvent.click(await screen.findByRole('button', { name: /Merge 2/ }));

      const dialog = await screen.findByRole('dialog');
      // The vanishing spelling is kept as the survivor's note rather than lost.
      expect(within(dialog).getByLabelText(enMessages.admin.catalogues.fields.note)).toHaveValue(
        'Also known as: Apartment',
      );
      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );

      await waitFor(() =>
        expect(merged).toMatchObject({
          ids: [kind.id, twin.id],
          name: 'apartment',
          note: 'Also known as: Apartment',
        }),
      );
    });

    it('shows the analyst groups and opens the same dialog prefilled from the answer', async () => {
      let merged: unknown = null;
      server.use(
        http.get('/api/subject-kinds', () =>
          HttpResponse.json(envelope({ nextCursor: null, items: [kind, twin] })),
        ),
        http.get('/api/admin/subject-kinds/merge-suggestions', () =>
          HttpResponse.json(
            envelope({
              state: 'ANSWERED',
              computedAt: '2026-08-30T10:00:00.000Z',
              groups: [
                { ids: [kind.id, twin.id], name: 'apartment', aka: ['Apartment'], note: null },
              ],
            }),
          ),
        ),
        http.post('/api/admin/subject-kinds/merge', async ({ request }) => {
          merged = await request.json();
          return HttpResponse.json(envelope(kind), { status: 201 });
        }),
      );

      renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });
      expect(
        await screen.findByText(enMessages.admin.subjectKinds.suggestions.title),
      ).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /Merge 2/ }));

      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByLabelText(enMessages.admin.catalogues.fields.mergedName),
      ).toHaveValue('apartment');
      await userEvent.click(
        within(dialog).getByRole('button', {
          name: enMessages.admin.catalogues.actions.mergeConfirm,
        }),
      );
      await waitFor(() =>
        expect(merged).toMatchObject({ ids: [kind.id, twin.id], name: 'apartment' }),
      );
    });

    it('says the analyst could not be asked, instead of showing nothing', async () => {
      server.use(
        http.get('/api/admin/subject-kinds/merge-suggestions', () =>
          HttpResponse.json(envelope({ state: 'UNAVAILABLE', computedAt: null, groups: [] })),
        ),
      );

      renderWithProviders(<SubjectKindsScreen />, { user: TEST_ADMIN });

      expect(
        await screen.findByText(enMessages.admin.catalogues.suggestions.unavailable),
      ).toBeInTheDocument();
      expect(screen.queryByText(enMessages.admin.subjectKinds.suggestions.title)).toBeNull();
    });
  });
});
