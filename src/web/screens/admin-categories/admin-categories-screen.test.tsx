import '@testing-library/jest-dom/vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope, errorEnvelope } from '../../../../test/helpers/msw';
import { enMessages, renderWithProviders } from '../../../../test/helpers/render';
import { AdminCategoriesScreen } from './admin-categories-screen';

const category = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  slug: 'invoice',
  name: 'Invoice',
  description: 'Bills and payment requests.',
  documentCount: 7,
};

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  server.use(http.get('/api/categories', () => HttpResponse.json(envelope({ items: [category] }))));
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('AdminCategoriesScreen', () => {
  it('shows the list with slugs and document counts', async () => {
    renderWithProviders(<AdminCategoriesScreen />);

    expect(await screen.findByText('invoice')).toBeInTheDocument();
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.getByText('Bills and payment requests.')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('creates a category', async () => {
    let created: unknown = null;
    server.use(
      http.post('/api/admin/categories', async ({ request }) => {
        created = await request.json();
        return HttpResponse.json(envelope(category), { status: 201 });
      }),
    );

    renderWithProviders(<AdminCategoriesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.categories.actions.create }),
    );

    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.categories.fields.slug),
      'contract',
    );
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.categories.fields.name),
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
      http.post('/api/admin/categories', () =>
        HttpResponse.json(errorEnvelope('CATEGORY_SLUG_TAKEN'), { status: 409 }),
      ),
    );

    renderWithProviders(<AdminCategoriesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.admin.categories.actions.create }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.categories.fields.slug),
      'invoice',
    );
    await userEvent.type(
      within(dialog).getByLabelText(enMessages.admin.categories.fields.name),
      'Invoice',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    expect(
      await screen.findByText(enMessages.errors.codes.CATEGORY_SLUG_TAKEN),
    ).toBeInTheDocument();
  });

  it('locks the slug when editing, since it cannot be changed', async () => {
    renderWithProviders(<AdminCategoriesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );

    const dialog = await screen.findByRole('dialog');
    const slug = within(dialog).getByLabelText(enMessages.admin.categories.fields.slug);
    expect(slug).toBeDisabled();
    expect(slug).toHaveValue('invoice');
    expect(
      within(dialog).getByText(enMessages.admin.categories.fields.slugImmutable),
    ).toBeInTheDocument();
  });

  it('sends only name and description when editing', async () => {
    let patched: unknown = null;
    server.use(
      http.patch('/api/admin/categories/:id', async ({ request }) => {
        patched = await request.json();
        return HttpResponse.json(envelope({ ...category, name: 'Invoices' }));
      }),
    );

    renderWithProviders(<AdminCategoriesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.edit }),
    );
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(enMessages.admin.categories.fields.name);
    await userEvent.clear(name);
    await userEvent.type(name, 'Invoices');
    await userEvent.click(
      within(dialog).getByRole('button', { name: enMessages.common.actions.save }),
    );

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).toEqual({ name: 'Invoices', description: 'Bills and payment requests.' });
  });

  it('names the category and the cost in the delete confirmation', async () => {
    renderWithProviders(<AdminCategoriesScreen />);
    await userEvent.click(
      await screen.findByRole('button', { name: enMessages.common.actions.delete }),
    );

    // 🔒 A destructive action says what it will do (docs/11 §11.14).
    expect(
      await screen.findByText(/Delete “Invoice”\? 7 documents will lose this category\./),
    ).toBeInTheDocument();
  });
});
