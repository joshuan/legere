import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { userDtoSchema, type UserDto } from '../../shared/contracts/auth';
import { PATHNAME_HEADER } from '../../middleware';

// Session guard for the authenticated area (docs/10 §10.2): an async server component that calls
// GET /api/me with the incoming cookies. A 401 redirects to /login carrying returnTo, so the user
// lands back where they were after signing in.
export default async function AppLayout({ children }: { children: ReactNode }) {
  await requireUser();
  return <>{children}</>;
}

async function requireUser(): Promise<UserDto> {
  const headerList = await headers();
  const cookie = headerList.get('cookie') ?? '';

  // Same process, same port (docs/02 §2.1) — the origin is reconstructed from the request itself
  // rather than duplicating APP_BASE_URL in the client build.
  const host = headerList.get('host') ?? 'localhost';
  const protocol = headerList.get('x-forwarded-proto') ?? 'http';
  // Set by middleware, since a server component cannot see its own request path.
  const returnTo = headerList.get(PATHNAME_HEADER) ?? '/documents';

  const response = await fetch(`${protocol}://${host}/api/me`, {
    headers: { cookie },
    cache: 'no-store',
  });

  if (!response.ok) {
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }

  const payload: unknown = await response.json();
  const parsed =
    typeof payload === 'object' && payload !== null && 'data' in payload
      ? userDtoSchema.safeParse(payload.data)
      : null;

  if (parsed === null || !parsed.success) {
    redirect('/login');
  }

  return parsed.data;
}
