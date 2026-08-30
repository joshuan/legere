import type { NextFunction, Request, Response } from 'express';
import { JSON_RPC, type JsonRpcResponse } from '../../../shared/contracts/mcp';
import { isReadOnlyPostRoute } from '../http/read-only-post-routes';

// `-32700`, the one JSON-RPC error the controller can never answer (docs/07 §7.3a): a body that
// does not parse dies inside `express.json`, before routing, so the promise is kept here — an error
// handler mounted right behind the parsers, catching exactly their `SyntaxError` and only for the
// MCP route. Which route that is is not spelled again: `isReadOnlyPostRoute` is the declaration the
// origin check, the read-only middleware and `SessionGuard` already consult, in both spellings of
// the path, and a fourth copy would be a fourth chance to drift.
//
// Every other route keeps its plain HTTP 400 — those clients read HTTP. This one reads JSON-RPC,
// with an HTTP 200 like every other protocol error on the route, and `id: null` because the id lies
// inside the very body that could not be read — which is what the specification asks for.
export function jsonRpcParseError(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(error instanceof SyntaxError) || !isReadOnlyPostRoute(req.method, req.path)) {
    next(error);
    return;
  }

  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: null,
    error: { code: JSON_RPC.parseError, message: 'The request body is not parsable JSON' },
  };
  res.status(200).json(response);
}
