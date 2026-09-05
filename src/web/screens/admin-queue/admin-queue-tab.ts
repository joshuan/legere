// Shared by the server route and the client-side tabs. The bare path is the overview so links stay
// short; every other tab is addressable and survives a reload or bookmark.
export const ADMIN_PROCESSING_TABS = ['overview', 'pipeline', 'services', 'failures'] as const;
export type AdminProcessingTab = (typeof ADMIN_PROCESSING_TABS)[number];

export function isAdminProcessingTab(value: string): value is AdminProcessingTab {
  return ADMIN_PROCESSING_TABS.some((tab) => tab === value);
}

export function adminProcessingHref(tab: AdminProcessingTab): string {
  return tab === 'overview' ? '/admin/processing' : `/admin/processing/${tab}`;
}
