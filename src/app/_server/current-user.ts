import { headers } from 'next/headers';
import { userDtoSchema, type UserDto } from '../../shared/contracts/auth';

// Server components ask the API who the caller is over the loopback of the process they are already
// running in: Express, Nest and Next share one port (docs/02 §2.1), and PORT is the port that
// process listens on.
//
// Reconstructing the origin from the request's Host header instead — what every guard here used to
// do — sends the call back out through whatever address the browser used. Inside a container that is
// a *published* port: with the default compose setup the browser says `localhost:3000`, the
// container hears `localhost:3000`, and nothing is listening there because the app is on 80. Every
// page then renders a 500. Loopback has no such gap and saves a round trip out of the container.
const INTERNAL_ORIGIN = `http://127.0.0.1:${process.env.PORT ?? '3000'}`;

// The signed-in user, or null when the session is missing, expired or unparseable. Callers decide
// what that means: the (app) layout redirects to /login, the admin segment answers 404.
export async function currentUser(): Promise<UserDto | null> {
  const headerList = await headers();

  const response = await fetch(`${INTERNAL_ORIGIN}/api/me`, {
    headers: { cookie: headerList.get('cookie') ?? '' },
    cache: 'no-store',
  });
  if (!response.ok) return null;

  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('data' in payload)) return null;

  const parsed = userDtoSchema.safeParse(payload.data);
  return parsed.success ? parsed.data : null;
}
