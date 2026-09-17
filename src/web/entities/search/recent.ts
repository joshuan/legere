'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ListDocumentsResponse } from '../../../shared/contracts/documents';
import { documentApi, documentKeys } from '../document';

// An empty search shows the archive's newest arrivals (docs/11 §11.6).
export function useRecentDocuments(enabled: boolean): UseQueryResult<ListDocumentsResponse> {
  return useQuery({
    queryKey: documentKeys.list({}, 'createdAt'),
    queryFn: () => documentApi.list({}, { sort: 'createdAt' }),
    enabled,
  });
}
