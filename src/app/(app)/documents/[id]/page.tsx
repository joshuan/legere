import { DocumentViewerScreen } from '../../../../web/screens/document-viewer';
import { currentUser } from '../../../_server/current-user';

// /documents/:id (docs/11 §11.5). The role decides whether the reprocess controls are rendered at
// all; the API refuses them regardless, so this is presentation, not authorization.
// /documents/:id — the address without a tab. It is not redirected: every link already written
// points here, and landing on the preview is what it always did.
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  return <DocumentViewerScreen id={id} tab="preview" isAdmin={user?.role === 'ADMIN'} />;
}
