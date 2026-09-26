import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import { libraryKeys } from '../../entities/library';
import { documentTypeKeys } from '../../entities/document-type';
import { DocumentFiltersBar } from './document-filters';

describe('DocumentFiltersBar hydration', () => {
  it('settles server-rendered loading markup when the shell has already populated the client cache', async () => {
    const change = vi.fn();
    const serverClient = new QueryClient();
    const browserClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    browserClient.setQueryData(libraryKeys.visible, {
      items: [{ id: 'library-1', name: 'Family archive' }],
    });
    browserClient.setQueryData(documentTypeKeys.all, { items: [] });
    const ui = (client: QueryClient) => (
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={client}>
          <DocumentFiltersBar value={{}} onChange={change} />
        </QueryClientProvider>
      </NextIntlClientProvider>
    );
    const container = document.createElement('div');
    container.innerHTML = renderToString(ui(serverClient));
    document.body.append(container);
    expect(container.querySelectorAll('.ant-select-arrow-loading')).toHaveLength(2);

    const root = hydrateRoot(container, ui(browserClient));
    try {
      await act(() => Promise.resolve());
      expect(container.querySelectorAll('.ant-select-arrow-loading')).toHaveLength(0);
      await userEvent.click(within(container).getByRole('combobox', { name: 'Library' }));
      await userEvent.click(within(document.body).getByText('Family archive'));
      expect(change).toHaveBeenCalledWith({ libraryId: 'library-1' });
    } finally {
      act(() => root.unmount());
      container.remove();
      serverClient.clear();
      browserClient.clear();
    }
  });
});
