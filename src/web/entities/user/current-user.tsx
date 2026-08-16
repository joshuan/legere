'use client';

import { createContext, use, type ReactNode } from 'react';
import type { UserDto } from '../../../shared/contracts/auth';

const CurrentUserContext = createContext<UserDto | null>(null);

// Who is reading this screen (docs/10 §10.2). The (app) layout has already asked the API — every
// page below it used to ask again, which cost a loopback call per navigation and, worse, made every
// page an async server component that the router could not commit until the answer came back.
export function CurrentUserProvider({ user, children }: { user: UserDto; children: ReactNode }) {
  return <CurrentUserContext value={user}>{children}</CurrentUserContext>;
}

export function useCurrentUser(): UserDto {
  const user = use(CurrentUserContext);
  if (user === null) {
    throw new Error('useCurrentUser is only available inside a CurrentUserProvider.');
  }
  return user;
}

// 🔒 What this answers is what gets drawn, never what may be done: the API authorizes every request
// on its own (docs/08 §8.5) and the admin segment is guarded on the server, because a role read in
// the browser is a role a browser can lie about (docs/10 §10.2).
export function useIsAdmin(): boolean {
  return useCurrentUser().role === 'ADMIN';
}
