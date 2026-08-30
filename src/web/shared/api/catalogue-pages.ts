import {
  DEFAULT_CATALOGUE_ORDER,
  DEFAULT_CATALOGUE_SORT,
  type CatalogueOrder,
} from '../../../shared/contracts/common';
import type { ZodType } from 'zod';
import { apiClient } from './client';

// How a catalogue page is arranged (docs/07 §7.3). The sort is left as a plain string because each
// catalogue's contract owns its own closed enum — the kinds list admits `things` and the other two
// do not — and this walker only carries the name to the server, which validates it.
export type CatalogueArrangement = { sort?: string; order?: CatalogueOrder };

// The catalogue endpoints answer bounded pages (docs/07 §7.1, SEC-56); the screens want the whole
// catalogue, so the client walks the pages. A hundred rows per ask keeps it to one round trip for
// years.
//
// 🔒 The arrangement goes with every page, cursor included: the cursor names the order it was cut
// from and the API refuses one that disagrees, so a walk that changed its mind halfway would be
// refused rather than answered off the wrong column (docs/07 §7.1).
export async function listAllPages<T>(
  path: string,
  schema: ZodType<{ items: T[]; nextCursor: string | null }>,
  { sort = DEFAULT_CATALOGUE_SORT, order = DEFAULT_CATALOGUE_ORDER }: CatalogueArrangement = {},
): Promise<{ items: T[] }> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: '100', sort, order });
    if (cursor !== null) params.set('cursor', cursor);
    const page: { items: T[]; nextCursor: string | null } = await apiClient.get(
      `${path}?${params.toString()}`,
      { schema },
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return { items };
}
