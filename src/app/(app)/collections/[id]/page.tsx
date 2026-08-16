import { use } from 'react';
import { CollectionDetailScreen } from '../../../../web/screens/collection-detail';

// /collections/:id (docs/11 §11.7). Whether the reader owns this collection decides which
// affordances render; the API enforces the same rule regardless.
//
// Synchronous: the screen asks the context who is reading it rather than being handed an id by a
// page that had to fetch one first, and there is no null case to guard here — a caller without a
// session never reaches this segment, the (app) layout having sent them to /login (docs/10 §10.2).
export default function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <CollectionDetailScreen id={id} />;
}
