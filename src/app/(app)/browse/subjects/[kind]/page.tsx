import { SubjectsOfKindFacetScreen } from '../../../../../web/screens/facets';
import { fetchSubjectKindName } from '../../../../_server/facet-names';

export default async function BrowseSubjectKindPage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind } = await params;
  return <SubjectsOfKindFacetScreen kindId={kind} title={await fetchSubjectKindName(kind)} />;
}
