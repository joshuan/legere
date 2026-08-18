import type { NextFunction, Request, Response } from 'express';
import { errorEnvelope } from './envelope';
import { isReadOnlyPostRoute } from './read-only-post-routes';

// Methods that cannot change state, so they need no origin proof.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Fail-closed origin check on every mutating /api request (docs/08 §8.4).
//
// The session cookie is SameSite=Lax, which already blocks cross-site POSTs from forms and fetch;
// this is the second layer and it is deliberately strict: a mutation whose Origin (or, failing
// that, Referer) is absent or does not match APP_BASE_URL is refused. "Absent" counts as a failure
// on purpose — accepting it would reopen the hole for clients that omit the header.
export function csrfOriginCheck(appBaseUrl: string) {
  const expected = new URL(appBaseUrl).origin;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    // 🔒 MCP is JSON-RPC over a POST, and that route authenticates by bearer token alone
    // (docs/08 §8.2a): it holds no credential a browser sends by itself, so there is no cross-site
    // request to forge. The check is not weakened here — it has nothing to act on.
    if (isReadOnlyPostRoute(req.method, req.path)) {
      next();
      return;
    }

    if (originOf(req) === expected) {
      next();
      return;
    }

    res
      .status(403)
      .json(errorEnvelope('FORBIDDEN', 'Request origin is missing or not allowed', null));
  };
}

function originOf(req: Request): string | null {
  const origin = req.get('origin');
  if (origin !== undefined && origin !== '') return safeOrigin(origin);

  const referer = req.get('referer');
  if (referer !== undefined && referer !== '') return safeOrigin(referer);

  return null;
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
