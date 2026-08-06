import type { NextFunction, Request, Response } from 'express';

// The headers every response carries (docs/12 §12.8).
//
// Written out rather than taken from a package: there are six of them, each is a decision this
// project has to be able to explain, and one of them has to be built from configuration at boot.
//
// What is deliberately NOT here is a page `script-src`. Ant Design's CSS-in-JS and Next's inline
// bootstrap both need either `'unsafe-inline'` — which would buy nothing while looking like it
// bought something — or a per-request nonce threaded through the Ant Design registry, which is a
// task of its own (backlog M15.7 names it). The `/api` surface gets the strict policy now, because
// nothing there has a reason to load anything at all.
const API_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// For pages: the one directive that costs nothing to enforce and closes clickjacking on a document
// viewer. `X-Frame-Options` goes with it for anything that predates `frame-ancestors`.
const PAGE_POLICY = "frame-ancestors 'none'";

// A year, the value HSTS preload requires. Only ever sent over HTTPS: a browser ignores it on plain
// HTTP, but an instance served on `http://<lan-ip>` — which docs/08 §8.2 deliberately supports —
// must never be told to upgrade a scheme it does not have.
const HSTS = 'max-age=31536000; includeSubDomains';

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

export function securityHeaders(options: { readonly usesHttps: boolean }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // No referrer at all, not the usual origin-only compromise: invite and reset links carry a
    // single-use credential in their path (docs/08 §8.1.2), and the day a page on this instance
    // loads something third-party, the browser default would send that path along with it.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', isApiPath(req.path) ? API_POLICY : PAGE_POLICY);

    if (options.usesHttps) res.setHeader('Strict-Transport-Security', HSTS);

    next();
  };
}
