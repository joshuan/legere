import { headers } from 'next/headers';
import { userDtoSchema } from '../../../shared/contracts/auth';
import { DocumentsScreen } from '../../../web/screens/documents';

// The home screen (docs/11 §11.3). The role is resolved here so the empty state can offer an admin
// the one action that fixes it — a regular user is told who can, not shown a button that 404s.
export default async function DocumentsPage() {
  return <DocumentsScreen isAdmin={await callerIsAdmin()} />;
}

async function callerIsAdmin(): Promise<boolean> {
  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost';
  const protocol = headerList.get('x-forwarded-proto') ?? 'http';

  const response = await fetch(`${protocol}://${host}/api/me`, {
    headers: { cookie: headerList.get('cookie') ?? '' },
    cache: 'no-store',
  });
  if (!response.ok) return false;

  const payload: unknown = await response.json();
  const parsed =
    typeof payload === 'object' && payload !== null && 'data' in payload
      ? userDtoSchema.safeParse(payload.data)
      : null;
  return parsed !== null && parsed.success && parsed.data.role === 'ADMIN';
}
