'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ListDocumentsResponse } from '../../../shared/contracts/documents';
import { documentApi, documentKeys } from '../document';

// What "nothing typed yet" is answered with, in one place: the shelf's newest arrivals. The search
// page's empty state and the overlay's both show them (docs/11 §11.6, §11.1a) — two screens
// answering that question differently would be two products — so the query, its key and its order
// are written once and shared rather than being kept in step by hand.
export function useRecentDocuments(enabled: boolean): UseQueryResult<ListDocumentsResponse> {
  return useQuery({
    queryKey: documentKeys.list({}, 'createdAt'),
    queryFn: () => documentApi.list({}, { sort: 'createdAt' }),
    enabled,
  });
}
