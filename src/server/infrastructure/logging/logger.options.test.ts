import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/app-config';
import { buildPinoHttpOptions, routeShapedUrl, serializeRequest } from './logger.options';

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
});

describe('buildPinoHttpOptions', () => {
  it('removes the credentials and the document names a request carries in its headers', () => {
    const paths = buildPinoHttpOptions(loadConfig(ENV)).redact.paths;

    expect(paths).toContain('req.headers.cookie');
    expect(paths).toContain('req.headers.authorization');
    expect(paths).toContain('res.headers["set-cookie"]');
    expect(paths).toContain('req.headers["x-legere-filename"]');
    expect(paths).toContain('req.headers["x-file-name"]');
  });
});
