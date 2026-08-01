import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { userDtoSchema } from '../../../../shared/contracts/auth';
import { CollectionDetailScreen } from '../../../../web/screens/collection-detail';

// /collections/:id (docs/11 §11.7). The caller's id decides which affordances render; the API
// enforces the same rule regardless.
export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await callerId();
  if (userId === null) notFound();
  return <CollectionDetailScreen id={id} currentUserId={userId} />;
}

async function callerId(): Promise<string | null> {
  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost';
  const protocol = headerList.get('x-forwarded-proto') ?? 'http';

  const response = await fetch(`${protocol}://${host}/api/me`, {
    headers: { cookie: headerList.get('cookie') ?? '' },
    cache: 'no-store',
  });
  if (!response.ok) return null;

  const payload: unknown = await response.json();
  const parsed =
    typeof payload === 'object' && payload !== null && 'data' in payload
      ? userDtoSchema.safeParse(payload.data)
      : null;
  return parsed !== null && parsed.success ? parsed.data.id : null;
}
