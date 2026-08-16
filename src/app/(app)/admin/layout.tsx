import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { currentUser } from '../../_server/current-user';

// Role guard for the admin segment (docs/10 §10.2). A non-admin gets 404 rather than 403: the
// existence of the admin area is not something a regular user needs confirmed. Authentication
// itself is already handled by the (app) layout above.
//
// 🔒 This asks the server again on purpose and stays here. It is authorization, and the role it acts
// on has to come from the session the API verified, not from anything the browser is holding. What
// it no longer is, is a second round trip: `currentUser` is memoized for the render pass, so the
// layout above has already paid for this answer (docs/08 §8.5, docs/10 §10.2).
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();
  if (user === null || user.role !== 'ADMIN') notFound();

  return <>{children}</>;
}
