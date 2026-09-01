import { callContextMiddleware as sharedCallContextMiddleware } from '@joshuan/observability/express';
import type { CallContext } from '../../application/ports/call-context';

export function callContextMiddleware(calls: CallContext) {
  return sharedCallContextMiddleware(calls);
}
