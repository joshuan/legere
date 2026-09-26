import { DocumentViewer } from '../../widgets/document-viewer';
import type { ViewerTab } from '../../entities/document';

export function DocumentViewerScreen({ id, tab }: { id: string; tab?: ViewerTab }) {
  return <DocumentViewer id={id} {...(tab === undefined ? {} : { tab })} />;
}
