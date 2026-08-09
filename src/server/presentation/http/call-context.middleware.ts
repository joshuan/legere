import type { NextFunction, Request, Response } from 'express';
import type { CallContext } from '../../application/ports/call-context';

// Runs the rest of an `/api` request inside the call context, so anything downstream can ask which
// request it is serving without being handed the request object (docs/06 §6.7). A job opens its own
// context the same way (docs/03 §3.3.18); this is the HTTP half, and the id is the one pino-http
// already minted for the request line and answered with as `X-Request-Id` — a record and its
// request line therefore carry the same id, which is the whole point of writing it down.
//
// Mounted after `pino-http`, because that is what sets `req.id`.
export function callContextMiddleware(calls: CallContext) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const requestId = req.id;
    // `genReqId` (logger.options.ts) returns a uuid, so the other shapes pino's type allows never
    // arrive here. If one ever did, the request goes on without a context: a record saying nothing
    // is better than one tied to an id nobody can look up.
    if (typeof requestId !== 'string') {
      next();
      return;
    }
    void calls.run(requestId, () => {
      next();
      return Promise.resolve();
    });
  };
}
