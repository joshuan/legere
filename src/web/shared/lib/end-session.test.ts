import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { endSession } from './end-session';

// 🔒 SEC-68 (docs/10 §10.5). The `QueryClient` outlives the transition to /login — it is created
// once in the root layout both route groups share — so what the last session cached is still in the
// browser when the next person signs in unless somebody empties it.
describe('endSession', () => {
  it('leaves nothing of the session behind, and lands on the login screen', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['documents'], { items: [{ title: 'Biopsy results 2026' }] });
    queryClient.setQueryData(['me'], { email: 'reader@legere.local' });
    const router = { replace: vi.fn() };

    endSession(queryClient, router);

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(queryClient.getQueryData(['documents'])).toBeUndefined();
    expect(router.replace).toHaveBeenCalledWith('/login');
  });
});
