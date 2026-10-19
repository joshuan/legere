import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { TEST_ADMIN, enMessages, renderWithProviders } from '../../../../test/helpers/render';
import {
  DocumentsOfPersonScreen,
  SubjectKindsFacetScreen,
  SubjectsOfKindFacetScreen,
} from './facet-screens';

const replace = vi.fn();
let currentSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => '/browse/subjects',
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}));

const PERSON_ID = 'dddddddd-1111-4111-8111-111111111111';

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  currentSearch = '';
});
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

describe('object cards', () => {
  const kind = {
    id: PERSON_ID,
    name: 'Company',
    note: 'Organisations in the archive',
    icon: null,
    subjectCount: 2,
    documentCount: 8,
    lastDocumentAt: '2026-06-30',
  };
  const company = {
    id: 'aaaaaaaa-2222-4222-8222-222222222222',
    kindId: PERSON_ID,
    kind: 'Company',
    name: 'Example company',
    note: 'Business records',
    icon: null,
    documentCount: 5,
    lastDocumentAt: null,
  };

  it('asks for document-count descending and shows kind counts and links', async () => {
    const seen: URLSearchParams[] = [];
    server.use(
      http.get('/api/subject-kinds', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(envelope({ items: [kind], nextCursor: null }));
      }),
    );
    renderWithProviders(<SubjectKindsFacetScreen />);
    const link = await screen.findByRole('link', { name: 'Company' });
    expect(link).toHaveAttribute('href', `/browse/subjects/${kind.id}`);
    expect(screen.getByText('8 documents')).toBeInTheDocument();
    expect(screen.getByText('2 objects')).toBeInTheDocument();
    expect(seen[0]?.get('sort')).toBe('documents');
    expect(seen[0]?.get('order')).toBe('desc');
    expect(screen.queryByRole('button', { name: /Change icon/ })).not.toBeInTheDocument();
  });

  it('honors the URL ordering and only shows the selected kind', async () => {
    currentSearch = 'sort=name&order=asc';
    const seen: URLSearchParams[] = [];
    server.use(
      http.get('/api/subjects', ({ request }) => {
        seen.push(new URL(request.url).searchParams);
        return HttpResponse.json(
          envelope({
            items: [
              company,
              {
                ...company,
                id: 'aaaaaaaa-3333-4333-8333-333333333333',
                kindId: 'bbbbbbbb-4444-4444-8444-444444444444',
                name: 'Unrelated object',
              },
            ],
            nextCursor: null,
          }),
        );
      }),
    );
    renderWithProviders(<SubjectsOfKindFacetScreen kindId={kind.id} title="Company" />);
    expect(await screen.findByRole('link', { name: 'Example company' })).toHaveAttribute(
      'href',
      `/browse/subjects/${kind.id}/${company.id}`,
    );
    expect(screen.getByText('5 documents')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated object')).not.toBeInTheDocument();
    expect(seen[0]?.get('sort')).toBe('name');
    expect(seen[0]?.get('order')).toBe('asc');
    await userEvent.click(
      screen.getByRole('combobox', { name: enMessages.catalogueCards.sortLabel }),
    );
    await userEvent.click(await screen.findByTitle(enMessages.catalogueCards.sorts.documents_desc));
    expect(replace).toHaveBeenCalledWith('/browse/subjects');
  });

  it('lets an admin change an icon without opening its card', async () => {
    let saved: unknown;
    server.use(
      http.get('/api/subjects', () =>
        HttpResponse.json(envelope({ items: [company], nextCursor: null })),
      ),
      http.patch(`/api/admin/catalogue-icons/subjects/${company.id}`, async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json(envelope({ icon: { type: 'symbol', symbol: 'bank' } }));
      }),
    );
    renderWithProviders(<SubjectsOfKindFacetScreen kindId={kind.id} title="Company" />, {
      user: TEST_ADMIN,
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Change icon for Example company' }),
    );
    await userEvent.click(screen.getByRole('radio', { name: 'Bank' }));
    await userEvent.click(screen.getByRole('button', { name: enMessages.common.actions.save }));
    await waitFor(() => expect(saved).toEqual({ symbol: 'bank' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(replace).not.toHaveBeenCalled();
  });
});

// Browsing by what a document is about (docs/11 §11.4): the same grid as the home screen, and an
// order of its own.
describe('a facet, once a folder is open', () => {
  it('asks for the date on the document by name rather than taking the list default', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(envelope({ items: [], nextCursor: null }));
      }),
    );

    renderWithProviders(<DocumentsOfPersonScreen id={PERSON_ID} title="Ana Petrović" />);
    await screen.findByText('Ana Petrović');

    // An order belongs to a screen and not to a person: the home screen's default is what came in
    // last, and this shelf is still read by the date on the paper (docs/07 §7.3, docs/11 §11.3).
    await waitFor(() => expect(seen[0]).toContain('sort=documentDate'));
    expect(seen[0]).toContain(`personId=${PERSON_ID}`);
  });
  it('offers the next cursor page without losing the facet filter', async () => {
    const seen: string[] = [];
    server.use(
      http.get('/api/documents', ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.search);
        return HttpResponse.json(
          envelope({ items: [], nextCursor: url.searchParams.has('cursor') ? null : 'next-page' }),
        );
      }),
    );
    renderWithProviders(<DocumentsOfPersonScreen id={PERSON_ID} title="Ana Petrović" />);
    await userEvent.click(await screen.findByRole('button', { name: enMessages.browse.more }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]).toContain('cursor=next-page');
    expect(seen[1]).toContain(`personId=${PERSON_ID}`);
    expect(seen[1]).toContain('sort=documentDate');
  });
});
