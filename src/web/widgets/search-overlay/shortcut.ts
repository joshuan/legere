'use client';

import { useSyncExternalStore } from 'react';

// Cmd where there is a Cmd, Ctrl everywhere else (docs/11 §11.1a). Read off the browser rather than
// guessed, and read from one place by the two things that must agree: the listener that opens the
// overlay and the hint the menu item writes beside itself.
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

const MAC_HINT = '⌘K';
const OTHER_HINT = 'Ctrl+K';

// Nothing to subscribe to: which keyboard this is does not change while the page is open.
const subscribe = (): (() => void) => () => undefined;

// The chord as it is written on this machine. The server has no navigator, so it renders the Ctrl
// form and the browser corrects it on hydration — a shortcut nobody is told about is a shortcut for
// the person who wrote it, and one written wrong is worse than none.
export function useShortcutHint(): string {
  return useSyncExternalStore(
    subscribe,
    () => (isMacPlatform() ? MAC_HINT : OTHER_HINT),
    () => OTHER_HINT,
  );
}
