import { DocumentsOfPersonScreen } from '../../../../../web/screens/facets';
import { fetchPersonName } from '../../../../_server/facet-names';

export default async function BrowsePersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentsOfPersonScreen id={id} title={await fetchPersonName(id)} />;
}
