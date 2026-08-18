import type { NextFunction, Request, Response } from 'express';
import { bearerTokenOf } from './bearer';
import { errorEnvelope } from './envelope';
import { isReadOnlyPostRoute } from './read-only-post-routes';

// Methods that cannot change state — the only ones an API token is allowed to reach.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// An API token may read and nothing else (docs/08 §8.2a).
//
// Enforced here, beside the origin check and before routing, for the same reason that one is: a
// rule about what a credential may do should not depend on every controller downstream remembering
// to ask. The token is not looked up — the header alone decides, so an expired or forged bearer on
// a POST is refused for the honest reason rather than for being invalid.
export function readOnlyBearer(req: Request, res: Response, next: NextFunction): void {
  if (
    SAFE_METHODS.has(req.method) ||
    // 🔒 The one route where a POST is a read, declared once (docs/08 §8.2a): MCP is JSON-RPC over
    // a POST, and it is the only credential that route takes.
    isReadOnlyPostRoute(req.method, req.path) ||
    bearerTokenOf(req) === undefined
  ) {
    next();
    return;
  }

  res
    .status(403)
    .json(errorEnvelope('READ_ONLY_TOKEN', 'An API token may only be used for safe methods', null));
}
