import { DocumentsOfSubjectScreen } from '../../../../../../web/screens/facets';
import { fetchSubjectName } from '../../../../../_server/facet-names';

export default async function BrowseSubjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentsOfSubjectScreen id={id} title={await fetchSubjectName(id)} />;
}
