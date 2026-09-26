import { useInfiniteQuery } from '@tanstack/react-query';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApiMock, envelope } from '../../../../test/helpers/msw';
import { renderWithProviders } from '../../../../test/helpers/render';
import { documentApi, documentKeys } from '.';
import { useRecentDocuments } from './recent';

const server = createApiMock();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function ArchiveAndRecentSearch() {
  const archive = useInfiniteQuery({
    queryKey: documentKeys.list({}, 'createdAt'),
    queryFn: () => documentApi.list({}, { sort: 'createdAt' }),
    initialPageParam: '',
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const recent = useRecentDocuments(true);
  return (
    <>
      <output aria-label="archive pages">{archive.data?.pages.length ?? 'loading'}</output>
      <output aria-label="recent documents">{recent.data?.items.length ?? 'loading'}</output>
    </>
  );
}

describe('recent search results', () => {
  it('does not share a cache entry with the archive infinite query', async () => {
    server.use(
      http.get('/api/documents', () =>
        HttpResponse.json(envelope({ items: [], nextCursor: null })),
      ),
    );
    renderWithProviders(<ArchiveAndRecentSearch />);
    expect(await screen.findByText('1')).toHaveAccessibleName('archive pages');
    expect(await screen.findByText('0')).toHaveAccessibleName('recent documents');
  });
});
