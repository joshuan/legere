'use client';

import { useSyncExternalStore } from 'react';

function subscribe() {
  return () => undefined;
}

function clientSnapshot() {
  return true;
}

function serverSnapshot() {
  return false;
}

// The server snapshot also runs during initial client hydration. A sibling may already have
// populated a shared query cache, but SSR markup must first hydrate with the same visible state.
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}
