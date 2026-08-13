// The viewer's tabs, in a module of their own — no 'use client' — because both sides need them: the
// screen renders them, and the route segment `/documents/:id/:tab` has to validate one on the
// server. A guard exported from a client module cannot be called there at all (docs/10 §10.2).
export const VIEWER_TABS = ['preview', 'text', 'details', 'files', 'log'] as const;
export type ViewerTab = (typeof VIEWER_TABS)[number];

export function isViewerTab(value: string): value is ViewerTab {
  return VIEWER_TABS.some((tab) => tab === value);
}
