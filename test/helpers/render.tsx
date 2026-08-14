import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import messages from '../../messages/en.json';
import { UploadQueueProvider } from '../../src/web/features/upload-queue';
import { SearchOverlayProvider } from '../../src/web/widgets/search-overlay';

// Renders a component with the same providers the app gives it (docs/10 §10.4), minus SSR-only
// pieces. Retries are off so a failing request surfaces immediately instead of after backoff.
//
// The upload queue and the search overlay are among them: the authenticated layout mounts both
// around every screen (docs/11 §11.3a, §11.1a), so a screen that hands the queue files — or a shell
// that raises the overlay — has one here too.
export function renderWithProviders(ui: ReactElement): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <NextIntlClientProvider locale="en" messages={messages}>
        <AntdApp>
          <QueryClientProvider client={queryClient}>
            <SearchOverlayProvider>
              <UploadQueueProvider>{children}</UploadQueueProvider>
            </SearchOverlayProvider>
          </QueryClientProvider>
        </AntdApp>
      </NextIntlClientProvider>
    );
  }

  return render(ui, { wrapper: Wrapper });
}

export { messages as enMessages };
