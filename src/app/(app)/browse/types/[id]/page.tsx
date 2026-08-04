import { DocumentsOfTypeScreen } from '../../../../../web/screens/facets';
import { fetchDocumentTypeName } from '../../../../_server/facet-names';

export default async function BrowseTypePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentsOfTypeScreen id={id} title={await fetchDocumentTypeName(id)} />;
}
