import { headers } from 'next/headers';
import { userDtoSchema } from '../../../../shared/contracts/auth';
import { DocumentViewerScreen } from '../../../../web/screens/document-viewer';

// /documents/:id (docs/11 §11.5). The role decides whether the reprocess controls are rendered at
// all; the API refuses them regardless, so this is presentation, not authorization.
export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DocumentViewerScreen id={id} isAdmin={await callerIsAdmin()} />;
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
