import { csrfOriginCheck as sharedCsrfOriginCheck } from '@joshuan/http/express';
import { isReadOnlyPostRoute } from './read-only-post-routes';

// These routes have no ambient browser credential: their controllers require a scoped bearer token.
function isAutomationIngestRoute(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  const normalized = path.replace(/\/+$/, '').toLowerCase();
  return [
    '/api/incoming/documents',
    '/api/incoming/receipts',
    '/incoming/documents',
    '/incoming/receipts',
  ].includes(normalized);
}

// Fail closed on mutating requests. The two exemptions have no ambient browser credential: MCP is
// read-only bearer auth and the inbox routes require a scoped bearer token a form cannot send.
export function csrfOriginCheck(appBaseUrl: string) {
  return sharedCsrfOriginCheck({
    appBaseUrl,
    exempt: (request) =>
      request.path.toLowerCase().startsWith('/api/') &&
      (isReadOnlyPostRoute(request.method, request.path) ||
        isAutomationIngestRoute(request.method, request.path)),
  });
}
