import { describe, expect, it } from 'vitest';
import { isReadOnlyPostRoute } from './read-only-post-routes';

// 🔒 SEC. The one hole in "a bearer token may not post" (docs/08 §8.2a). Its whole safety rests on
// being exactly one route, so that is what this asserts — not the behaviour of the three guards
// that consult it, which have tests of their own, but the shape of the exception itself.
describe('isReadOnlyPostRoute', () => {
  it('is the MCP route, spelled with the prefix and without it', () => {
    // The origin check runs above the dispatcher and sees the full path; everything mounted under
    // `/api` sees the rest of it. One list, both spellings.
    expect(isReadOnlyPostRoute('POST', '/api/mcp')).toBe(true);
    expect(isReadOnlyPostRoute('POST', '/mcp')).toBe(true);
    expect(isReadOnlyPostRoute('POST', '/mcp/')).toBe(true);
  });

  it('matches the way the router resolves, not the way the string was typed', () => {
    // 🔒 Express routes case-insensitively by default, so `/api/MCP` is the same controller as
    // `/api/mcp` — a matcher stricter than its router put the guard on the cookie branch there
    // (SEC-87).
    expect(isReadOnlyPostRoute('POST', '/api/MCP')).toBe(true);
    expect(isReadOnlyPostRoute('POST', '/API/mcp/')).toBe(true);
    expect(isReadOnlyPostRoute('POST', '/Mcp')).toBe(true);
  });

  it('is nothing else in this API', () => {
    for (const path of [
      '/api/documents',
      '/api/documents/aaaaaaaa-1111-4111-8111-111111111111/reprocess',
      '/api/admin/queue/reprocess',
      '/api/auth/login',
      '/api/mcp/tools',
      '/api/mcpx',
      '/mcp/anything',
    ]) {
      expect(isReadOnlyPostRoute('POST', path)).toBe(false);
    }
  });

  it('is a POST and no other method', () => {
    for (const method of ['PATCH', 'PUT', 'DELETE', 'GET', 'HEAD', 'OPTIONS']) {
      expect(isReadOnlyPostRoute(method, '/api/mcp')).toBe(false);
    }
  });
});
