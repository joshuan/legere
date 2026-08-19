import type { ServiceName } from '../../../shared/contracts/queue';

// The failure that is a fact about the instance and never a verdict on a document (docs/05 §5.4e).
// Thrown by the service clients where the transport itself failed or a proxy answered for a process
// that is not there; caught by the step runner, which puts the step back to QUEUED and lets pg-boss
// retry the job, and by the service's gate, which refuses the units that follow while the hold
// lasts.
export class ServiceUnavailableError extends Error {
  constructor(
    readonly service: ServiceName,
    detail: string,
  ) {
    super(`The ${service} service is unreachable: ${detail}`);
    this.name = 'ServiceUnavailableError';
  }
}

// The three ways a proxy says "the thing behind me is not there" (docs/05 §5.4e). Nothing else
// qualifies: a 500 is the service answering — that document broke it — and a 404 is configuration,
// which §5.4c's probes already put on a screen.
export function isUnavailableStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

// One whole exchange with a service — the request, the status check, the body read — with the
// transport's own failures translated into the typed error and every other throw left exactly as
// it was. What counts as transport is deliberately narrow: undici rejects every network-level
// failure as TypeError('fetch failed'), tears a mid-body connection down as TypeError('terminated'),
// and surfaces the call's own §5.4a timeout as an abort — and a plain TypeError is none of those,
// because a programming error classified as weather would be retried for ever.
export async function reachService<T>(
  service: ServiceName,
  exchange: () => Promise<T>,
): Promise<T> {
  try {
    return await exchange();
  } catch (error) {
    if (error instanceof ServiceUnavailableError) throw error;
    if (isTransportFailure(error)) {
      throw new ServiceUnavailableError(
        service,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError) {
    return error.message === 'fetch failed' || error.message === 'terminated';
  }
  return (
    error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}
