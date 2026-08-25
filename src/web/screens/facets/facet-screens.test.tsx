import '@testing-library/jest-dom/vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { renderWithProviders } from '../../../../test/helpers/render';
import { DocumentsOfPersonScreen } from './facet-screens';

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const PERSON_ID = 'dddddddd-1111-4111-8111-111111111111';

const server = createApiMock();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.clearAllMocks();
});
afterAll(() => server.close());

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
});
