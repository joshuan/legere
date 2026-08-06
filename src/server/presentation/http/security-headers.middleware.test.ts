import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { securityHeaders } from './security-headers.middleware';

// A real Express instance rather than a stubbed request and response: the middleware's whole job is
// the headers that come out the other side, and that is what this reads.
function appWith(options: { usesHttps: boolean }): Express {
  const app = express();
  app.use(securityHeaders(options));
  app.get('/api/documents', (_req, res) => {
    res.json({ data: [] });
  });
  app.get('/documents', (_req, res) => {
    res.send('a page');
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
  });

  it('does not carry the API policy onto a page, which would leave the page blank', async () => {
    const response = await request(appWith({ usesHttps: false })).get('/documents');

    expect(response.headers['content-security-policy']).not.toContain("default-src 'none'");
    expect(response.text).toBe('a page');
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
