// Where a login lands when it has nowhere better to go (docs/10 §10.2, docs/11 §11.2).
const FALLBACK_RETURN_TO = '/documents';

// `?returnTo=` is attacker-controllable. The `(app)` layout only ever writes a path there, but
// nothing stops a crafted link from carrying an absolute URL, and Next's app router classifies an
// off-origin href as external and performs a real `location.replace()` — which turns a genuine
// login on a genuine host into a hand-off to somebody else's page.
//
// Resolving the candidate against the current origin and comparing origins collapses every shape of
// that trick into one check: absolute URLs, protocol-relative `//host`, the backslash variants the
// URL parser normalizes to slashes, and `javascript:` (an opaque origin, which never matches).
// What survives is a location on this instance, reduced to `pathname + search + hash`.
//
// Callers must apply this at the point of navigation, not where the query is read: it needs
// `window`, and a guard that lives at the sink also covers the next caller to wire the prop.
export function safeReturnTo(candidate: string | null | undefined): string {
  const origin = window.location.origin;

  // A document with an opaque origin serializes it as the string "null" — and so does a
  // `javascript:` URL, so the comparison below would let one through. There is nothing safe to
  // return to from such a document anyway.
  if (
    candidate === null ||
    candidate === undefined ||
    candidate === '' ||
    origin === 'null' ||
    origin === ''
  ) {
    return FALLBACK_RETURN_TO;
  }

  let resolved: URL;
  try {
    resolved = new URL(candidate, origin);
  } catch {
    return FALLBACK_RETURN_TO;
  }

  if (resolved.origin !== origin) return FALLBACK_RETURN_TO;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
