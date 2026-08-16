import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { CurrentUserProvider } from '../../web/entities/user';
import { UploadQueueProvider } from '../../web/features/upload-queue';
import { AppShell } from '../../web/widgets/app-shell';
import { SearchOverlayProvider } from '../../web/widgets/search-overlay';
import { UploadPanelLayout } from '../../web/widgets/upload-panel';
import { PATHNAME_HEADER } from '../../middleware';
import { APP_VERSION } from '../_server/app-version';
import { currentUser } from '../_server/current-user';

// Session guard for the authenticated area (docs/10 §10.2): an async server component that asks the
// API who the caller is with the incoming cookies. No user redirects to /login carrying returnTo, so
// they land back where they were after signing in.
export default async function AppLayout({ children }: { children: ReactNode }) {
  // The shell needs the user anyway (name, role), so the guard's answer is reused rather than
  // fetched twice (docs/11 §11.1). It is also the only fetch a navigation pays for: `currentUser` is
  // memoized for the render pass, so the admin guard below it is a hit, and what comes back is
  // handed to the client tree rather than asked for again by every page under it (docs/10 §10.2).
  const user = await currentUser();
  if (user === null) {
    // Set by middleware, since a server component cannot see its own request path.
    const returnTo = (await headers()).get(PATHNAME_HEADER) ?? '/documents';
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  // The upload queue is the whole authenticated area's, not one screen's (docs/11 §11.3): a file
  // being sent survives walking to another page, and the panel beside the screen is where it is
  // watched. Inside the client providers of the root layout, so it has the query cache to refresh.
  //
  // The search overlay is here for the same reason and one more: its Cmd+K / Ctrl+K listener is
  // bound once, by the layout, rather than by each screen — a hotkey registered per screen works on
  // four of them and is a bug on the fifth (docs/10 §10.2, docs/11 §11.1a).
  //
  // The user goes into the client tree here, outermost, so that a screen wanting to know who is
  // reading it — whether to offer an admin's affordances, whether this collection is the reader's
  // own — reads it from context instead of being handed it by a page that had to fetch it first
  // (docs/10 §10.2).
  return (
    <CurrentUserProvider user={user}>
      <SearchOverlayProvider>
        <AppShell user={user} version={APP_VERSION}>
          <UploadQueueProvider>
            <UploadPanelLayout>{children}</UploadPanelLayout>
          </UploadQueueProvider>
        </AppShell>
      </SearchOverlayProvider>
    </CurrentUserProvider>
  );
}
