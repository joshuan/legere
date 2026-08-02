import { notFound } from 'next/navigation';
import { CollectionDetailScreen } from '../../../../web/screens/collection-detail';
import { currentUser } from '../../../_server/current-user';

// /collections/:id (docs/11 §11.7). The caller's id decides which affordances render; the API
// enforces the same rule regardless.
export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  if (user === null) notFound();
  return <CollectionDetailScreen id={id} currentUserId={user.id} />;
}
