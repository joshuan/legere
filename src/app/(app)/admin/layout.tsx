import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { userDtoSchema } from '../../../shared/contracts/auth';

// Role guard for the admin segment (docs/10 §10.2). A non-admin gets 404 rather than 403: the
// existence of the admin area is not something a regular user needs confirmed. Authentication
// itself is already handled by the (app) layout above.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const headerList = await headers();
  const host = headerList.get('host') ?? 'localhost';
  const protocol = headerList.get('x-forwarded-proto') ?? 'http';

  const response = await fetch(`${protocol}://${host}/api/me`, {
    headers: { cookie: headerList.get('cookie') ?? '' },
    cache: 'no-store',
  });
  if (!response.ok) notFound();

  const payload: unknown = await response.json();
  const parsed =
    typeof payload === 'object' && payload !== null && 'data' in payload
      ? userDtoSchema.safeParse(payload.data)
      : null;

  if (parsed === null || !parsed.success || parsed.data.role !== 'ADMIN') notFound();

  return <>{children}</>;
}
