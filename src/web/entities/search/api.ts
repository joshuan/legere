import {
  searchResponseSchema,
  type SearchMode,
  type SearchSort,
  type SearchResponse,
} from '../../../shared/contracts/search';
import { apiClient } from '../../shared/api';

export type SearchInput = {
  q: string;
  mode: SearchMode;
  sort?: SearchSort | undefined;
  // How many hits are wanted. Absent is the contract's default (20).
  limit?: number | undefined;
  libraryId?: string | undefined;
  typeId?: string | undefined;
};

// GET /api/search (docs/07 §7.3).
export const searchApi = {
  search: (input: SearchInput): Promise<SearchResponse> =>
    apiClient.get('/api/search', { schema: searchResponseSchema, query: { ...input } }),
};

export const searchKeys = {
  query: (input: SearchInput) => ['search', input] as const,
};
