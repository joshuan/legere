import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// The headers every response carries (docs/12 §12.8a).
//
// Written out rather than taken from a package: there are six of them, each is a decision this
// project has to be able to explain, and two of them are built from configuration and from a value
// that only exists once the request does.
//
// The `/api` surface gets a policy that lets nothing load at all, because nothing there has a
// reason to load anything.
const API_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// The origin the login page's CAPTCHA widget fetches its script from and talks to afterwards
// (docs/08 §8.4). Named **unconditionally**, and that is a decision rather than laziness: whether
// this build has a widget at all is decided by `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, which Next inlines
// into the client bundle at build time, so a correctly built image does not carry it in the
// environment this process reads (docs/12 §12.6). The server cannot tell the two cases apart — the
// same reason §8.4 gives for warning about the secret unconditionally — and of the two ways to be
// wrong, a policy that names an origin nobody calls costs nothing, while a policy that omits the one
// the widget needs is a sign-in page nobody on the instance can get past.
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

// 🔒 The page policy, rebuilt per request because one of its values is per request.
//
// - `frame-ancestors` closes clickjacking on a document viewer. `X-Frame-Options` goes with it for
//   anything that predates it.
// - `script-src` is the one that blunts a stored XSS: `'self'` for browsers that have never heard of
//   `'strict-dynamic'`, the request's own nonce for everything Next writes, and `'strict-dynamic'`
//   so a script that is already trusted may load another — which is how the CAPTCHA widget's script
//   arrives, since it is created by our bundle and appended, never written into the markup. There is
//   deliberately no `'unsafe-inline'`: it is ignored by any browser that honours the nonce, and on
//   the ones that do not it would hand back exactly what this directive exists to take away.
// - `connect-src` is worth having only now that `script-src` exists — it constrains code that is
//   already running. `'self'` is the app's own API, which is the only thing the client calls today;
//   the bucket is there because every route to a derived artifact answers `302` into that origin,
//   and a redirect a `fetch` follows is checked against `connect-src` again.
// - `img-src` closes the read receipt. A document's Markdown is what the parser read off the pages,
//   and a page can say `![](https://beacon.example/p.png?d=payroll)`; rendered, it tells the person
//   who put the document there which readers opened it and from where, out of a deployment that is
//   often meant to have no way out at all (SEC-66).
// - `object-src` keeps the viewer's `<object>` embed of the canonical PDF and refuses every other
//   origin a plugin could be pointed at.
// - `base-uri` and `form-action` are free.
//
// The bucket has to be named in the three fetch directives: a preview `<img>` and the canonical
// `<object>` point at `/api/documents/:id/…`, which answers 302 to the browser-facing bucket origin,
// and a CSP is checked again against the host a redirect lands on. `data:` rides along for what the
// UI toolkit inlines. A bucket origin that does not parse leaves the app's own origin, which is the
// safe direction: a broken preview is visible, a silent hole is not.
//
// What is deliberately absent is `style-src`. Ant Design's CSS-in-JS writes `<style>` elements from
// the browser and `@ant-design/nextjs-registry` writes one more during SSR, and neither can carry a
// nonce today — `StyleProvider` has no prop for one (docs/10 §10.4). A `style-src` would therefore
// have to say `'unsafe-inline'`, which is the shape of protection this task exists to refuse.
function pagePolicy(bucketOrigin: string | null, nonce: string): string {
  const bucket = bucketOrigin === null ? '' : ` ${bucketOrigin}`;
  return [
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `connect-src 'self'${bucket} ${TURNSTILE_ORIGIN}`,
    `img-src 'self' data:${bucket}`,
    `object-src 'self'${bucket}`,
  ].join('; ');
}

// 128 bits of randomness, base64 — the size the CSP specification asks for, in the alphabet Next's
// own reader accepts. Minted per response and never reused: a nonce that outlives one page is a
// nonce an injected script can read off that page and write into the next request's markup.
const newNonce = (): string => randomBytes(16).toString('base64');

// A year, the value HSTS preload requires. Only ever sent over HTTPS: a browser ignores it on plain
// HTTP, but an instance served on `http://<lan-ip>` — which docs/08 §8.2 deliberately supports —
// must never be told to upgrade a scheme it does not have.
const HSTS = 'max-age=31536000; includeSubDomains';

const isApiPath = (path: string): boolean => path === '/api' || path.startsWith('/api/');

export function securityHeaders(options: {
  readonly usesHttps: boolean;
  readonly bucketOrigin: string | null;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // No referrer at all, not the usual origin-only compromise: invite and reset links carry a
    // single-use credential in their path (docs/08 §8.1.2), and the day a page on this instance
    // loads something third-party, the browser default would send that path along with it.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    if (isApiPath(req.path)) {
      res.setHeader('Content-Security-Policy', API_POLICY);
    } else {
      const policy = pagePolicy(options.bucketOrigin, newNonce());
      res.setHeader('Content-Security-Policy', policy);
      // 🔒 And the same string back onto the **request**, overwriting whatever arrived under that
      // name. This is the whole of how the nonce reaches the page (docs/10 §10.4): this middleware
      // is mounted above the dispatcher, Next is handed the request afterwards, and Next reads its
      // own `content-security-policy` request header, takes the first nonce out of `script-src` and
      // stamps it on every script tag it writes. Overwriting rather than merging is the security
      // here — a caller who could leave their own nonce in that header would be choosing what the
      // page trusts.
      req.headers['content-security-policy'] = policy;
    }

    if (options.usesHttps) res.setHeader('Strict-Transport-Security', HSTS);

    next();
  };
}
