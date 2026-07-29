import { NextResponse, type NextRequest } from 'next/server';

// A server component cannot see the request path, so the session guard in the (app) layout has no
// way to build an accurate returnTo on its own (docs/10 §10.2). Middleware copies the path into a
// request header the layout can read.
export const PATHNAME_HEADER = 'x-legere-pathname';

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.next({ request: { headers } });
}

// Everything Next renders; /api belongs to Nest and never reaches this (docs/02 §2.2).
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
