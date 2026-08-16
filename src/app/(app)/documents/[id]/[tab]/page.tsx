import { notFound } from 'next/navigation';
import { use } from 'react';
import { DocumentViewerScreen } from '../../../../../web/screens/document-viewer';
import { isViewerTab } from '../../../../../web/screens/document-viewer/viewer-tab';

// /documents/:id/:tab (docs/11 §11.5). The open tab is part of the address so that a link to a
// document can be a link to its text: shared, bookmarked, and reloaded where it was left.
//
// Synchronous, and deliberately the cheapest segment in the tree: the viewer rewrites this address
// itself every time a tab is pressed (`router.replace`), so anything this page waited for would be
// waited for again on every press. 🔒 For the same reason no loading boundary may sit above it
// (docs/10 §10.2).
export default function DocumentTabPage({
  params,
}: {
  params: Promise<{ id: string; tab: string }>;
}) {
  const { id, tab } = use(params);
  // An unknown tab is a wrong address, not a reason to guess which one was meant.
  if (!isViewerTab(tab)) notFound();

  return <DocumentViewerScreen id={id} tab={tab} />;
}
