// The tabs of /admin/queue, in a module of their own — no 'use client' — because both sides need
// them: the screen renders them, and the route segment `/admin/queue/:tab` has to validate one on the
// server, where a guard exported from a client module cannot be called at all (docs/10 §10.2).
//
// One tab per question asked of this screen (docs/11 §11.13): is anything moving, where are the
// documents stuck, is the thing we call answering, what broke.
export const ADMIN_QUEUE_TABS = ['overview', 'pipeline', 'services', 'failures'] as const;
export type AdminQueueTab = (typeof ADMIN_QUEUE_TABS)[number];

export function isAdminQueueTab(value: string): value is AdminQueueTab {
  return ADMIN_QUEUE_TABS.some((tab) => tab === value);
}

// `overview` lives at the bare path, so the address an admin already has in a bookmark keeps working
// and the default tab is not spelled out twice.
export function adminQueueHref(tab: AdminQueueTab): string {
  return tab === 'overview' ? '/admin/queue' : `/admin/queue/${tab}`;
}
