import { getScriptNonceFromHeader } from 'next/dist/server/app-render/get-script-nonce-from-header';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerVerifyResponseSchema } from '../../src/shared/contracts/auth';
import { api, createTestApp, type TestApp } from '../helpers/app';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';
import { seedDocument, seedLibrary } from '../helpers/documents';
import { cookieNamed, expectData } from '../helpers/http';

const PASSWORD = 'a-decent-passphrase';

// The origin `InMemoryFileStorage` signs its URLs under, made the browser-facing bucket origin for
// this suite so the policy the app serves can be held against the redirects the app actually
// answers. Nothing here talks to S3: the storage port is the in-memory double as in every e2e suite.
const BUCKET = 'http://in-memory-storage.test';

// What Next does with the request it is handed, reduced to the part this task is about, and using
// **Next's own** reader rather than a copy of it: `getScriptNonceFromHeader` is the function
// `app-render` calls on `headers['content-security-policy']` before it renders a page, and what it
// returns is what lands on every script tag Next writes.
//
// 🔒 What this proves and what it does not. It proves the middleware puts a nonce where Next looks
// for it, in a form Next's parser accepts, and that the value the browser is told to trust is the
// value the markup carries. It does not prove that Next still *looks* there — that is a fact about
// the framework, checked by rendering a real page (docs/10 §10.4a), and this suite would stay green
// if a future Next stopped reading the header. Importing Next's own module rather than a regex is
// the closest a test without a browser gets: the day that file moves, this fails and somebody reads
// §10.4a again.
function renderLikeNext(csp: string | string[] | undefined): string {
  const nonce = typeof csp === 'string' ? getScriptNonceFromHeader(csp) : undefined;
  const attribute = nonce === undefined ? '' : ` nonce="${nonce}"`;
  return [
    '<!DOCTYPE html><html><body>',
    `<script src="/_next/static/chunks/main.js"${attribute} async></script>`,
    `<script${attribute}>self.__next_f.push([1,"legere"])</script>`,
    '</body></html>',
  ].join('');
}

// Every `nonce="…"` in the markup, and a marker for a script tag that carries none — so a page that
// forgot one is a failure rather than an empty list that trivially matches.
function scriptNonces(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>/g)].map((tag) => {
    const attribute = /nonce="([^"]*)"/.exec(tag[1] ?? '');
    return attribute?.[1] ?? '(none)';
  });
}

function nonceOf(policy: string): string {
  const found = getScriptNonceFromHeader(policy);
  if (found === undefined) throw new Error(`no nonce in: ${policy}`);
  return found;
}

// The page CSP and the nonce that makes it worth having (docs/12 §12.8a, docs/10 §10.4a).
describe('The page policy (e2e)', () => {
  let app: TestApp;
  let adminCookie: string;
  let previousPublicEndpoint: string | undefined;
  let seq = 0;

  beforeAll(async () => {
    previousPublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    process.env.S3_PUBLIC_ENDPOINT = BUCKET;
    app = await createTestApp({
      nextHandle: (req, res) => res.send(renderLikeNext(req.headers['content-security-policy'])),
    });
  });

  beforeEach(async () => {
    await truncateAll();
    app.emails.reset();
    seq += 1;
    adminCookie = await onboard(`cspadmin${seq}@legere.local`);
  });

  afterAll(async () => {
    await app.close();
    await disconnectTestPrisma();
    if (previousPublicEndpoint === undefined) delete process.env.S3_PUBLIC_ENDPOINT;
    else process.env.S3_PUBLIC_ENDPOINT = previousPublicEndpoint;
  });

  async function onboard(email: string): Promise<string> {
    await api(app).post('/api/auth/register/start', { email });
    const verified = await api(app).post('/api/auth/register/verify', {
      email,
      code: app.emails.lastCodeFor(email),
    });
    const completed = await api(app).post('/api/auth/register/complete', {
      ticket: expectData(verified, registerVerifyResponseSchema).ticket,
      password: PASSWORD,
    });
    const sid = cookieNamed(completed, 'sid');
    if (sid === undefined) throw new Error('onboarding did not set a session cookie');
    return sid;
  }

  const policyOf = (headers: Record<string, string | undefined>): string =>
    headers['content-security-policy'] ?? '';

  it('serves a page whose script tags carry the nonce the browser was told to trust', async () => {
    const page = await api(app).get('/documents');

    const policy = policyOf(page.headers);
    expect(policy).toContain("'strict-dynamic'");
    const nonce = nonceOf(policy);
    // Every script tag, not merely one: a page that stamps the first and forgets the second is a
    // page whose bootstrap runs and whose data does not.
    expect(scriptNonces(page.text)).toEqual([nonce, nonce]);
  });

  it('gives the next page a nonce of its own', async () => {
    const first = await api(app).get('/documents');
    const second = await api(app).get('/documents');

    const before = nonceOf(policyOf(first.headers));
    const after = nonceOf(policyOf(second.headers));
    expect(before).not.toBe(after);
    // And each page's markup follows its own header rather than the other's.
    expect(scriptNonces(first.text)).toEqual([before, before]);
    expect(scriptNonces(second.text)).toEqual([after, after]);
  });

  // 🔒 The nonce is written onto the request, never read from it. A caller who could name it would
  // be naming what the page trusts — and, since the browser holds the policy this server chose,
  // would break every script on the page for the person they sent the link to.
  it('ignores a nonce the caller tried to put in the request', async () => {
    const page = await api(app)
      .get('/documents')
      .set('Content-Security-Policy', "script-src 'nonce-attackerchosenvalue'");

    expect(page.text).not.toContain('attackerchosenvalue');
    expect(scriptNonces(page.text)).toEqual([
      nonceOf(policyOf(page.headers)),
      nonceOf(policyOf(page.headers)),
    ]);
  });

  // The viewer's three things: the document itself, the preview `<img>` and the canonical `<object>`.
  // Both artifacts answer a 302 into the bucket, and a CSP is checked again against the host a
  // redirect lands on — so the assertion is that the policy the page was served with names the
  // origin the app really sends the browser to, rather than an origin a fixture made up.
  it('still lets the viewer load a document, its preview and its canonical PDF', async () => {
    const libraryId = await seedLibrary({ visibility: 'ALL_USERS' });
    const seeded = await seedDocument({
      libraryId,
      document: { canonicalStatus: 'DONE', previewStatus: 'DONE' },
    });

    const page = await api(app).get(`/documents/${seeded.id}`);
    const policy = policyOf(page.headers);

    const detail = await api(app).get(`/api/documents/${seeded.id}`).set('Cookie', adminCookie);
    expect(detail.status).toBe(200);

    const preview = await api(app)
      .get(`/api/documents/${seeded.id}/preview`)
      .set('Cookie', adminCookie)
      .redirects(0);
    const canonical = await api(app)
      .get(`/api/documents/${seeded.id}/canonical`)
      .set('Cookie', adminCookie)
      .redirects(0);

    expect(preview.status).toBe(302);
    expect(canonical.status).toBe(302);
    const previewOrigin = new URL(preview.headers['location'] ?? '').origin;
    const canonicalOrigin = new URL(canonical.headers['location'] ?? '').origin;

    expect(policy).toContain(`img-src 'self' data: ${previewOrigin}`);
    expect(policy).toContain(`object-src 'self' ${canonicalOrigin}`);
    // And the same origin in `connect-src`, because a redirect a fetch follows is checked against it.
    expect(policy).toContain(
      `connect-src 'self' ${canonicalOrigin} https://challenges.cloudflare.com`,
    );
  });

  // Nothing under `/api` renders, so nothing there needs a nonce — and `default-src 'none'` already
  // refuses everything the page directives spell out (docs/12 §12.8a).
  it('leaves the API surface on the strict policy it already had', async () => {
    const response = await api(app).get('/api/health');
    const policy = policyOf(response.headers);

    expect(policy).toBe(
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});
