import { use } from 'react';
import { DocumentViewerScreen } from '../../../../web/screens/document-viewer';

// /documents/:id — the address without a tab (docs/11 §11.5). It is not redirected: every link
// already written points here, and landing on the preview is what it always did.
//
// Synchronous: the parameters are read with `use` rather than awaited, and the role that decides
// whether the reprocess controls are drawn comes from the context above — the API refuses them
// regardless, so this is presentation, not authorization. Nothing here waits on the network, which
// is what makes a press on a card land on the document at once (docs/10 §10.2).
export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DocumentViewerScreen id={id} tab="preview" />;
}
