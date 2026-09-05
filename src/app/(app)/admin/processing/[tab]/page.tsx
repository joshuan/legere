import { notFound } from 'next/navigation';
import { use } from 'react';
import { AdminProcessingScreen } from '../../../../../web/screens/admin-queue';
import { isAdminProcessingTab } from '../../../../../web/screens/admin-queue/admin-queue-tab';

export default function AdminProcessingTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = use(params);
  if (!isAdminProcessingTab(tab)) notFound();
  return <AdminProcessingScreen tab={tab} />;
}
