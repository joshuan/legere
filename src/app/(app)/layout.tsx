import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { UploadQueueProvider } from '../../web/features/upload-queue';
import { AppShell } from '../../web/widgets/app-shell';
import { UploadPanelLayout } from '../../web/widgets/upload-panel';
import { PATHNAME_HEADER } from '../../middleware';
import { APP_VERSION } from '../_server/app-version';
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
  // The upload queue is the whole authenticated area's, not one screen's (docs/11 §11.3): a file
  // being sent survives walking to another page, and the panel beside the screen is where it is
  // watched. Inside the client providers of the root layout, so it has the query cache to refresh.
  return (
    <AppShell user={user} version={APP_VERSION}>
      <UploadQueueProvider>
        <UploadPanelLayout>{children}</UploadPanelLayout>
      </UploadQueueProvider>
    </AppShell>
  );
}
