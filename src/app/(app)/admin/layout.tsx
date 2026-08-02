import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentUser } from '../../_server/current-user';

// Role guard for the admin segment (docs/10 §10.2). A non-admin gets 404 rather than 403: the
// existence of the admin area is not something a regular user needs confirmed. Authentication
// itself is already handled by the (app) layout above.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (user === null || user.role !== 'ADMIN') notFound();

  return <>{children}</>;
}
