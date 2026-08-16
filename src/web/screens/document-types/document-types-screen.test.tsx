import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { DocumentTypesScreen } from './document-types-screen';

const documentType = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  slug: 'invoice',
  name: 'Invoice',
  description: 'Bills and payment requests.',
  documentCount: 7,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(
    http.get('/api/document-types', () => HttpResponse.json(envelope({ items: [documentType] }))),
  );
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('DocumentTypesScreen', () => {
  it('shows the list with slugs and document counts', async () => {
    renderWithProviders(<DocumentTypesScreen />, { user: TEST_ADMIN });

    expect(await screen.findByText('invoice')).toBeInTheDocument();
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.getByText('Bills and payment requests.')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('creates a documentType', async () => {
    let created: unknown = null;
    server.use(
      http.post('/api/admin/document-types', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(envelope(documentType), { status: 201 });
      }),
    );

    renderWithProviders(<DocumentTypesScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.documentTypes.actions.create }),
    );

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.documentTypes.fields.slug),
      'contract',
    );
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.documentTypes.fields.name),
      'Contract',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    await waitFor(() => expect(created).not.toBeNull());
    expect(created).toEqual({ slug: 'contract', name: 'Contract', description: null });
  });

  it('reports a slug that is already taken instead of failing quietly', async () => {
    server.use(
      http.post('/api/admin/document-types', () =>
        HttpResponse.json(errorEnvelope('DOCUMENT_TYPE_SLUG_TAKEN'), { status: 409 }),
      ),
    );

    renderWithProviders(<DocumentTypesScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.documentTypes.actions.create }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.documentTypes.fields.slug),
      'invoice',
    );
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.documentTypes.fields.name),
      'Invoice',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    expect(
      await screen.findByText(enMessages.errors.codes.DOCUMENT_TYPE_SLUG_TAKEN),
    ).toBeInTheDocument();
  });

  it('locks the slug when editing, since it cannot be changed', async () => {
    renderWithProviders(<DocumentTypesScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );

    const dialog = await screen.findByRole('dialog');
    const slug = within(dialog).getByLabelText(enMessages.admin.documentTypes.fields.slug);
    expect(slug).toBeDisabled();
    expect(slug).toHaveValue('invoice');
    expect(
      within(dialog).getByText(enMessages.admin.documentTypes.fields.slugImmutable),
    ).toBeInTheDocument();
  });

  it('sends only name and description when editing', async () => {
    let patched: unknown = null;
    server.use(
      http.patch('/api/admin/document-types/:id', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...documentType, name: 'Invoices' }));
      }),
    );

    renderWithProviders(<DocumentTypesScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(enMessages.admin.documentTypes.fields.name);
    await userEvent.clear(name);
    await userEvent.type(name, 'Invoices');
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toEqual({ name: 'Invoices', description: 'Bills and payment requests.' });
  });

  it('names the documentType and the cost in the delete confirmation', async () => {
    renderWithProviders(<DocumentTypesScreen />, { user: TEST_ADMIN });
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.delete }),
    );

    // 🔒 A destructive action says what it will do (docs/11 §11.14).
    expect(
      await screen.findByText(/Delete “Invoice”\? 7 documents will lose this type\./),
    ).toBeInTheDocument();
  });

  it('is readable by anyone and editable by an admin', async () => {
    renderWithProviders(<DocumentTypesScreen />);

    // The list a filter is built on and a document wears: everybody reads it.
    expect(await screen.findByText('Invoice')).toBeInTheDocument();
    // 🔒 Defining a type is an admin's, exactly as the API has it (docs/07 §7.3).
    expect(
      screen.queryByRole('button', { name: enMessages.admin.documentTypes.actions.create }),
    ).toBeNull();
    expect(screen.queryByRole('button', { name: enMessages.common.actions.edit })).toBeNull();
  });
});
