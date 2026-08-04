import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminSubjectKindsScreen } from './admin-subject-kinds-screen';

const kind = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  name: 'apartment',
  note: null,
  subjectCount: 3,
  documentCount: 11,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(http.get('/api/subject-kinds', () => HttpResponse.json(envelope({ items: [kind] }))));
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminSubjectKindsScreen', () => {
  it('shows what hangs off a kind, which is what it is worth keeping for', async () => {
    renderWithProviders(<AdminSubjectKindsScreen />);

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

    renderWithProviders(<AdminSubjectKindsScreen />);
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

  it('says a kind still holding things cannot simply be deleted', async () => {
    renderWithProviders(<AdminSubjectKindsScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.delete }),
    );

    // 🔒 The server refuses this one (SUBJECT_KIND_IN_USE), so the confirmation says why rather than
    // offering a button that cannot work (docs/03 §3.3.20a).
    expect(await screen.findByText(/still holds 3 things/)).toBeInTheDocument();
  });
});
