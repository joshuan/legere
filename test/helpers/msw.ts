import { setupServer } from 'msw/node';
import type { RequestHandler } from 'msw';

// One msw server per test file (docs/14 §14.8: component tests for forms/wizards use msw).
export function createApiMock(...handlers: RequestHandler[]) {
  return setupServer(...handlers);
}

// Success envelope, the shape every endpoint answers with (docs/07 §7.1).
export function envelope(data: unknown): { data: unknown } {
  return { data };
}

export function errorEnvelope(code: string, message = 'error', details: unknown = null) {
  return { error: { code, message, details } };
}
