import { csrfOriginCheck as sharedCsrfOriginCheck } from '@joshuan/http/express';
import { isReadOnlyPostRoute } from './read-only-post-routes';

// Fail closed on mutating requests. The only exemption is the bearer-authenticated, read-only MCP
// POST route: it carries no ambient browser credential, so there is no cross-site request to forge.
export function csrfOriginCheck(appBaseUrl: string) {
  return sharedCsrfOriginCheck({
    appBaseUrl,
    exempt: (request) =>
      request.path.toLowerCase().startsWith('/api/') &&
      isReadOnlyPostRoute(request.method, request.path),
  });
}
