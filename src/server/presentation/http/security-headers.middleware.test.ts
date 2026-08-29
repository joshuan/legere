import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers.middleware';

const BUCKET = 'https://files.legere.example';
const TURNSTILE = 'https://challenges.cloudflare.com';

// The nonce as it stands in a policy string, so a test can read out what the browser would trust.
function nonceIn(policy: string): string {
  const match = /script-src [^;]*'nonce-([^']+)'/.exec(policy);
  if (match?.[1] === undefined) throw new Error(`no nonce in: ${policy}`);
  return match[1];
}

// A real Express instance rather than a stubbed request and response: the middleware's whole job is
// the headers that come out the other side, and that is what this reads. The page route echoes the
// request header the middleware wrote, since that is the channel the nonce reaches Next through.
function appWith(options: { usesHttps: boolean; bucketOrigin?: string | null }): Express {
  const app = express();
  app.use(
    securityHeaders({
      usesHttps: options.usesHttps,
      bucketOrigin: options.bucketOrigin === undefined ? BUCKET : options.bucketOrigin,
    }),
  );
  app.get('/api/documents', (_req, res) => {
    res.json({ data: [] });
  });
  app.get('/documents', (req, res) => {
    res.send(String(req.headers['content-security-policy'] ?? ''));
  });
  return app;
}

describe('securityHeaders', () => {
  it('refuses to be framed, sniffed, or to leak where the reader came from', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/documents');

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    // 🔒 Invite and reset links carry a single-use credential in their path (docs/08 §8.1.2), so the
    // browser default of sending the origin cross-site is not enough.
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['permissions-policy']).toContain('camera=()');
  });

  it('lets nothing load at all on the API surface', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/api/documents');
    const policy = response.headers['content-security-policy'] ?? '';

    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    // The strict policy is whole in itself: `default-src 'none'` already refuses every script and
    // every fetch, so the page's directives have no business here and no nonce is minted for a
    // response nothing renders.
    expect(policy).not.toContain('script-src');
    expect(policy).not.toContain('nonce-');
  });

  it('does not carry the API policy onto a page, which would leave the page blank', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/documents');

    expect(response.headers['content-security-policy']).not.toContain("default-src 'none'");
  });

  // 🔒 SEC-66. A document's Markdown is what the parser read off its pages, and a page can say
  // `![](https://beacon.example/p.png)`. Rendered, that tells whoever put the document there which
  // readers opened it and from where — no script required, so no `script-src` is required to stop
  // it either.
  it('lets a page load pictures from itself and the bucket, and from nowhere else', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/documents');
    const policy = response.headers['content-security-policy'] ?? '';

    expect(policy).toContain(`img-src 'self' data: ${BUCKET}`);
    // The preview `<img>` and the canonical `<object>` point at `/api/documents/:id/…`, which
    // answers 302 to the bucket — and a CSP is checked again against the host a redirect lands on.
    expect(policy).toContain(`object-src 'self' ${BUCKET}`);
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'self'");
  });

  // A `S3_PUBLIC_ENDPOINT` that does not parse leaves the app's own origin standing: a preview that
  // does not load is visible, and a policy that quietly allows everything is not.
  it('names only the app when there is no bucket origin to name', async () => {
    const response = await request(appWith({ usesHttps: false, bucketOrigin: null })).get(
      '/documents',
    );
    const policy = response.headers['content-security-policy'] ?? '';

    expect(policy).toContain("img-src 'self' data:;");
    expect(policy).toContain("object-src 'self'");
    expect(policy).toContain(`connect-src 'self' ${TURNSTILE}`);
  });

  // 🔒 M47.19. The directive that blunts a stored XSS, in the only shape worth shipping: no
  // `'unsafe-inline'`, which every browser that honours the nonce ignores anyway and which on the
  // rest would give back exactly what the nonce takes away.
  it('lets only what it named run, and only what is already running fetch', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/documents');
    const policy = response.headers['content-security-policy'] ?? '';

    expect(policy).toContain(`script-src 'self' 'nonce-${nonceIn(policy)}' 'strict-dynamic'`);
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    // 'self' is the app's own API; the bucket is where every artifact route redirects to; and the
    // CAPTCHA origin is named whether or not this build has a widget, because the site key that
    // decides is baked into the client bundle and not into this process (docs/08 §8.4).
    expect(policy).toContain(`connect-src 'self' ${BUCKET} ${TURNSTILE}`);
  });

  // A nonce that outlived one response would be a nonce an injected script could read off the page
  // it is on and write into the markup of the next one.
  it('mints a new nonce for every page it answers', async () => {
    const app = appWith({ usesHttps: false });

    const first = await request(app).get('/documents');
    const second = await request(app).get('/documents');

    const before = nonceIn(first.headers['content-security-policy'] ?? '');
    const after = nonceIn(second.headers['content-security-policy'] ?? '');
    expect(before).not.toBe(after);
    // Long enough to be unguessable, in the alphabet Next's reader accepts.
    expect(before).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });

  // How the nonce reaches the page at all (docs/10 §10.4): Next reads its own request headers.
  it('hands the page renderer the same policy it hands the browser', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/documents');
    const sent = response.headers['content-security-policy'] ?? '';

    expect(response.text).toBe(sent);
  });

  // 🔒 The request header is written, never read: a caller who could leave their own nonce standing
  // there would be choosing what the page trusts, and the browser — holding *our* policy — would
  // then refuse every script the page actually carries.
  it('overwrites a nonce a caller tried to choose for the page', async () => {
    const response = await request(appWith({ usesHttps: false }))
      .get('/documents')
      .set('Content-Security-Policy', "script-src 'nonce-attackerchosenvalue'");

    expect(response.text).not.toContain('attackerchosenvalue');
    expect(response.text).toBe(response.headers['content-security-policy']);
  });

  // Sent to an instance served over plain HTTP — which docs/08 §8.2 deliberately supports on a LAN
  // — this would tell the browser to upgrade to a scheme that instance does not have.
  it('asks for HTTPS only where there is HTTPS to ask for', async () => {
    const plain = await request(appWith({ usesHttps: false })).get('/');
    const secure = await request(appWith({ usesHttps: true })).get('/');

    expect(plain.headers['strict-transport-security']).toBeUndefined();
    expect(secure.headers['strict-transport-security']).toContain('max-age=');
  });
});
