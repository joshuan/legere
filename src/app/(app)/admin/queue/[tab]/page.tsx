import { notFound } from 'next/navigation';
import { use } from 'react';
import { AdminQueueScreen } from '../../../../../web/screens/admin-queue';
import { isAdminQueueTab } from '../../../../../web/screens/admin-queue/admin-queue-tab';

// /admin/queue/:tab (docs/11 §11.13). The open tab is part of the address, so a link to this screen
// can be a link to the failures — shared, bookmarked, and reloaded where it was left.
//
// Synchronous, and deliberately the cheapest segment in the tree: the screen rewrites this address
// itself every time a tab is pressed (`router.replace`), so anything this page waited for would be
// waited for again on every press. 🔒 For the same reason no loading boundary may sit above it
// (docs/10 §10.2).
export default function AdminQueueTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = use(params);
  // An unknown tab is a wrong address, not a reason to guess which one was meant.
  if (!isAdminQueueTab(tab)) notFound();

  return <AdminQueueScreen tab={tab} />;
}
