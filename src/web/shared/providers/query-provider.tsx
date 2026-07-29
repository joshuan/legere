'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { isApiError } from '../api/api-error';

// TanStack Query defaults (docs/10 §10.5): never retry a 4xx — those are decisions, not blips —
// and do not refetch on focus, which would hammer the API on every tab switch.
export function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) =>
          failureCount < 2 && isApiError(error) && (error.status >= 500 || error.status === 0),
      },
    },
  });
}

// One client per browser session, created lazily so the server render never shares cache with a
// client render.
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(buildQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
