import { SubjectsOfKindFacetScreen } from '../../../../../web/screens/facets';

export default async function BrowseSubjectKindPage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind } = await params;
  return <SubjectsOfKindFacetScreen kind={decodeURIComponent(kind)} />;
}
