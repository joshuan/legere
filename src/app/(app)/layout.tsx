import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../../web/widgets/app-shell';
import { PATHNAME_HEADER } from '../../middleware';
import { currentUser } from '../_server/current-user';

// Session guard for the authenticated area (docs/10 §10.2): an async server component that asks the
// API who the caller is with the incoming cookies. No user redirects to /login carrying returnTo, so
// they land back where they were after signing in.
export default async function AppLayout({ children }: { children: ReactNode }) {
  // The shell needs the user anyway (name, role), so the guard's answer is reused rather than
  // fetched twice (docs/11 §11.1).
  const user = await currentUser();
  if (user === null) {
    // Set by middleware, since a server component cannot see its own request path.
    const returnTo = (await headers()).get(PATHNAME_HEADER) ?? '/documents';
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  return <AppShell user={user}>{children}</AppShell>;
}
