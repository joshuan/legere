import type { QueryClient } from '@tanstack/react-query';

// Where the router is asked to go once a session is over. `replace`, not `push`: the page behind is
// no longer readable, and a Back button that returns to it is a promise the server will not keep.
export type LoginRedirect = { replace: (href: string) => void };

// 🔒 The one way out of a session, wherever it is asked for (docs/10 §10.5).
//
// Everything cached belongs to the session that just ended, and the `QueryClient` is created once in
// the root layout shared by `(app)` and `(public)` — so `router.replace('/login')` is a client-side
// transition that never remounts it. Without the `clear()`, the next person to sign in on that
// browser renders the previous one's documents, filters and account out of cache before any refetch
// lands, which on a shared machine is somebody else's archive on screen.
//
// It lives here because there are two ways a session ends from the UI — the shell's *Sign out* and
// the sessions card's revoke of the row tagged `current` — and they differed: one cleared the cache,
// the other did not, and nothing made the omission visible (SEC-68). A third exit is now one call
// away rather than one omission away.
export function endSession(queryClient: QueryClient, router: LoginRedirect): void {
  queryClient.clear();
  router.replace('/login');
}
