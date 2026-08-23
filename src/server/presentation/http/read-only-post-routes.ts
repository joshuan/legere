// 🔒 The one route where a POST is a read (docs/08 §8.2a, ADR-024).
//
// MCP speaks JSON-RPC over a single POST, so three rules that all say "a bearer token may not post"
// would each refuse the protocol outright: the origin check above the dispatcher, the read-only
// middleware in front of routing, and `SessionGuard` behind it. Declared once here and consulted by
// all three, because a rule with three copies is a rule with three chances of drifting — the same
// reason `isRawBodyRoute` exists beside the parsers it exempts.
//
// What makes the exception safe is not that it is narrow but what is on the other side: the route
// accepts no cookie, so it holds no credential a browser sends by itself, and the tools it
// dispatches to are a closed list over read use cases.
const READ_ONLY_POST_PATHS = new Set(['/mcp', '/api/mcp']);

// The path is matched with and without the `/api` prefix on purpose: the origin check runs above
// the dispatcher and sees `/api/mcp`, while everything mounted under `server.use('/api', …)` sees
// `/mcp`. One list, both spellings, so neither caller has to know where it stands.
export function isReadOnlyPostRoute(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  return READ_ONLY_POST_PATHS.has(normalize(path));
}

// A trailing slash is the same route, and a query string never reaches `req.path` — but a router
// that changes shape should not be able to turn `/mcp/` into an unguarded address either.
// 🔒 Lower-cased, because Express routes case-insensitively by default: `/api/MCP` reaches the same
// controller as `/api/mcp`, and a matcher stricter than its router is a rule with a spelling that
// escapes it (SEC-87) — at `/api/MCP` the guard took the cookie branch the exemption exists to
// forbid.
function normalize(path: string): string {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return trimmed.toLowerCase();
}
