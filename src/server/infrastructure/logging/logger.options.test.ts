import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/app-config';
import {
  buildPinoHttpOptions,
  routeShapedUrl,
  serializeRequest,
  serializeResponse,
} from './logger.options';

const ENV = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
  AUTH_SECRET: 'x'.repeat(32),
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

// A 32-byte token the way SessionTokens mints one (docs/08 §8.1.2): base64url, mixed case.
const TOKEN = 'x1nT8QpVb2-ZrK_4wQfLmA9sYd3CjHt0UePgRi7NkBs';

// pino-http hands a custom serializer the standard serializer's output, so this mirrors that shape.
function serialized(url: string, headers: Record<string, string> = {}) {
  return serializeRequest({
    id: 'req-1',
    method: 'GET',
    url,
    headers,
    remoteAddress: '127.0.0.1',
    remotePort: 51234,
  });
}

// 🔒 SEC-10 (docs/06 §6.7, docs/08 §8.1.2).
describe('routeShapedUrl', () => {
  it('keeps a route and replaces the token an invite or reset link carries in its path', () => {
    expect(routeShapedUrl(`/api/invites/${TOKEN}`)).toBe('/api/invites/:x');
    expect(routeShapedUrl(`/api/password-resets/${TOKEN}`)).toBe('/api/password-resets/:x');
  });

  it('leaves a URL made only of route literals exactly as it is', () => {
    expect(routeShapedUrl('/api/auth/register/start')).toBe('/api/auth/register/start');
    expect(routeShapedUrl('/api/health')).toBe('/api/health');
    expect(routeShapedUrl('/')).toBe('/');
  });

  it('replaces identifiers too, rather than keeping a list of which segments are secret', () => {
    expect(routeShapedUrl('/api/documents/0f5f0f2c-1b7e-4a2f-9a1e-2f6a1a2b3c4d/files')).toBe(
      '/api/documents/:x/files',
    );
    expect(routeShapedUrl('/api/admin/users/42/password-reset')).toBe(
      '/api/admin/users/:x/password-reset',
    );
  });

  it('drops the query string, so a search never says what was searched for', () => {
    expect(routeShapedUrl('/api/search?q=divorce%20papers&limit=20')).toBe('/api/search');
  });

  it('shapes a page URL as well, since a link lands on one before it reaches the API', () => {
    expect(routeShapedUrl(`/invite/${TOKEN}`)).toBe('/invite/:x');
    expect(routeShapedUrl(`/reset/${TOKEN}`)).toBe('/reset/:x');
  });
});

describe('the request serializer', () => {
  it('logs the shaped URL and nothing else of what the request carried', () => {
    const req = serialized(`/api/invites/${TOKEN}?next=/documents`);

    expect(req.url).toBe('/api/invites/:x');
    expect(JSON.stringify(req)).not.toContain(TOKEN);
    // The fields Express fills with the same material are not part of the shape at all.
    expect(Object.keys(req)).toEqual([
      'id',
      'method',
      'url',
      'headers',
      'remoteAddress',
      'remotePort',
    ]);
  });

  it('keeps what a request line is for: the id, the method and the caller', () => {
    const req = serialized('/api/documents', { 'user-agent': 'legere-test' });

    expect(req).toMatchObject({
      id: 'req-1',
      method: 'GET',
      url: '/api/documents',
      remoteAddress: '127.0.0.1',
      headers: { 'user-agent': 'legere-test' },
    });
  });

  // 🔒 SEC-23 applied to the request half of the line, as SEC-58 applied it to the response half.
  // The headers were a deny-list of four; the point of the lesson is the fifth.
  describe('its headers', () => {
    it('keeps the four that say what kind of request it was and who says they sent it', () => {
      const req = serialized('/api/documents', {
        'content-type': 'application/pdf',
        'content-length': '1024',
        'user-agent': 'legere-test',
        origin: 'http://localhost:3000',
      });

      expect(req.headers).toEqual({
        'content-type': 'application/pdf',
        'content-length': '1024',
        'user-agent': 'legere-test',
        origin: 'http://localhost:3000',
      });
    });

    it('drops the credentials and the document names the old deny-list named', () => {
      const req = serialized('/api/documents', {
        cookie: 'sid=a-live-session',
        authorization: 'Bearer a-read-only-api-token',
        'x-legere-filename': 'biopsy%20results%202026.pdf',
        'x-file-name': 'biopsy results 2026.pdf',
      });

      expect(req.headers).toEqual({});
      expect(JSON.stringify(req)).not.toContain('a-live-session');
      expect(JSON.stringify(req)).not.toContain('biopsy');
    });

    // The one a deny-list would not have thought of. `Referrer-Policy: no-referrer` keeps a browser
    // from sending it; a client following an invite link out of a chat window is not a browser, and
    // that link is a bearer credential in a path (docs/08 §8.1.2).
    it('drops Referer, which is the URL the request side is scrubbed of arriving by another door', () => {
      const req = serialized('/api/auth/register/start', {
        referer: `http://localhost:3000/invite/${TOKEN}`,
        origin: 'http://localhost:3000',
      });

      expect(JSON.stringify(req)).not.toContain(TOKEN);
      expect(req.headers).toEqual({ origin: 'http://localhost:3000' });
    });

    it('drops a header this codebase has never heard of', () => {
      const req = serialized('/api/documents', { 'x-legere-next-secret': 'whatever it becomes' });

      expect(req.headers).toEqual({});
    });
  });
});

// 🔒 SEC-58 (docs/06 §6.7, docs/09 §9.2). What a download answers with is a credential and a file
// name, and pino's standard response serializer writes every header there is.
describe('the response serializer', () => {
  const SIGNED =
    'http://minio:9000/legere/documents/0f5f0f2c-1b7e-4a2f-9a1e-2f6a1a2b3c4d/canonical.pdf' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=9c1f0a2b3c4d5e6f';

  function serializedResponse(headers: Record<string, string>) {
    return serializeResponse({ statusCode: 302, headers });
  }

  it('drops the presigned URL a download redirects to', () => {
    const res = serializedResponse({
      location: SIGNED,
      'content-disposition': 'attachment; filename="biopsy results 2026.pdf"',
    });

    expect(JSON.stringify(res)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(res)).not.toContain('biopsy');
    expect(res.headers).toEqual({});
    expect(res.statusCode).toBe(302);
  });

  it('keeps the three that say how a request ended and nothing about what it carried', () => {
    const res = serializedResponse({
      'content-type': 'application/pdf',
      'content-length': '1024',
      'retry-after': '60',
      'x-request-id': 'req-1',
      'set-cookie': 'sid=secret; HttpOnly',
    });

    expect(res.headers).toEqual({
      'content-type': 'application/pdf',
      'content-length': '1024',
      'retry-after': '60',
    });
  });

  // The point of an allow-list rather than a deny-list (SEC-23): the header nobody has thought of
  // yet is dropped by the rule that already exists, not by an amendment to it.
  it('drops a header this codebase has never heard of', () => {
    const res = serializedResponse({ 'x-legere-next-secret': 'whatever it turns out to be' });

    expect(res.headers).toEqual({});
  });
});

describe('buildPinoHttpOptions', () => {
  // Both serializers are allow-lists now, so there is nothing left for a redact path to match: the
  // four it used to name are dropped before pino ever sees them. A rule that can never fire is a
  // claim about a defence standing somewhere it does not stand.
  it('carries no deny-list of headers at all any more', () => {
    expect(buildPinoHttpOptions(loadConfig(ENV))).not.toHaveProperty('redact');
  });

  it('serializes both halves of a request line, so neither falls back to pino’s own', () => {
    const serializers = buildPinoHttpOptions(loadConfig(ENV)).serializers;

    expect(serializers.req).toBe(serializeRequest);
    expect(serializers.res).toBe(serializeResponse);
  });
});
