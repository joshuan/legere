import { notFound } from 'next/navigation';
import { DocumentsOfYearScreen } from '../../../../../web/screens/facets';

export default async function BrowseYearPage({ params }: { params: Promise<{ year: string }> }) {
  const { year } = await params;
  const parsed = Number(year);
  // A year is four digits or it is a wrong address, not a filter to guess at.
  if (!/^\d{4}$/.test(year) || parsed < 1900 || parsed > 2100) notFound();
  return <DocumentsOfYearScreen year={parsed} />;
}
