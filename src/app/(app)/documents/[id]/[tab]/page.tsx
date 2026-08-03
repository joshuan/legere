import { notFound } from 'next/navigation';
import { DocumentViewerScreen } from '../../../../../web/screens/document-viewer';
import { isViewerTab } from '../../../../../web/screens/document-viewer/viewer-tab';
import { currentUser } from '../../../../_server/current-user';

// /documents/:id/:tab (docs/11 §11.5). The open tab is part of the address so that a link to a
// document can be a link to its text: shared, bookmarked, and reloaded where it was left.
export default async function DocumentTabPage({
  params,
}: {
  params: Promise<{ id: string; tab: string }>;
}) {
  const { id, tab } = await params;
  // An unknown tab is a wrong address, not a reason to guess which one was meant.
  if (!isViewerTab(tab)) notFound();

  const user = await currentUser();
  return <DocumentViewerScreen id={id} tab={tab} isAdmin={user?.role === 'ADMIN'} />;
}
