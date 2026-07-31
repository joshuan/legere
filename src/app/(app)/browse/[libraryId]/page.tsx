import { BrowseScreen } from '../../../../web/screens/browse';

// /browse/:libraryId (docs/11 §11.4).
export default async function BrowsePage({ params }: { params: Promise<{ libraryId: string }> }) {
  const { libraryId } = await params;
  return <BrowseScreen libraryId={libraryId} />;
}
