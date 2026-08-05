import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { SubjectsScreen } from './subjects-screen';

const APARTMENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const BOAT = 'bbbbbbbb-2222-4222-8222-222222222222';

const subject = {
  id: 'cccccccc-3333-4333-8333-333333333333',
  kindId: APARTMENT,
  kind: 'apartment',
  name: 'Njegoševa 5',
  note: null,
  documentCount: 4,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/subjects', () => HttpResponse.json(envelope({ items: [subject] }))),
    http.get('/api/subject-kinds', () =>
      HttpResponse.json(
        envelope({
          items: [
            { id: APARTMENT, name: 'apartment', note: null, subjectCount: 1, documentCount: 4 },
            { id: BOAT, name: 'boat', note: null, subjectCount: 0, documentCount: 0 },
          ],
        }),
      ),
    ),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('SubjectsScreen', () => {
  it('shows both halves of a thing and how many documents it is on', async () => {
    renderWithProviders(<SubjectsScreen isAdmin />);

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

    renderWithProviders(<SubjectsScreen isAdmin />);
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
            items: [
              subject,
              { ...subject, id: 'dddddddd-4444-4444-8444-444444444444', name: 'the flat' },
            ],
          }),
        ),
      ),
    );

    renderWithProviders(<SubjectsScreen isAdmin />);
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
      }),
    );
  });

  it('says a delete leaves the documents alone rather than implying they change', async () => {
    renderWithProviders(<SubjectsScreen isAdmin />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.delete }),
    );

    // The confirmation carries the count, because "delete this" and "delete this from four
    // documents" are different questions (docs/11 §11.12a).
    expect(await screen.findByText(/stays on the 4 documents/)).toBeInTheDocument();
  });
});
