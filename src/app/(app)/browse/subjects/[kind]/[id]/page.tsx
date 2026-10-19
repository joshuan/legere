import { notFound } from 'next/navigation';
import { DocumentsScreen } from '../../../../../../web/screens/documents';
import { fetchSubject } from '../../../../../_server/facet-names';

export default async function BrowseSubjectPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = await params;
  const subject = await fetchSubject(id);
  if (subject.kindId !== kind) notFound();
  return <DocumentsScreen subject={subject} />;
}
