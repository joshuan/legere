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

// A provider that answered, but explicitly declined work until an absolute instant (docs/05
// §5.4b). It remains a ServiceUnavailableError so the step runner keeps the interrupted step
// QUEUED, while the more precise type lets the shared gate hold callers instead of making each one
// spend a retry of its own.
export class ServiceThrottledError extends ServiceUnavailableError {
  constructor(
    service: ServiceName,
    readonly retryAfter: Date,
  ) {
    super(service, `rate limited until ${retryAfter.toISOString()}`);
    this.name = 'ServiceThrottledError';
    this.message = `The ${service} service is throttled until ${retryAfter.toISOString()}`;
  }
}

// A remote header must not be able to keep a worker — or an in-memory timer — beyond the queue's
// own recovery bound. Three hours is document-process's expireInSeconds (docs/06 §6.8).
export const MAX_RETRY_AFTER_MS = 3 * 60 * 60_000;

// RFC 9110 Retry-After is either delay-seconds or an HTTP date. The adapter calls this at the
// response boundary, the only layer that still has the header; the gate receives one absolute
// instant whatever spelling the provider chose.
export function parseRetryAfter(value: string | null, now: Date): Date | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  let deadlineMs: number;
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds)) return null;
    deadlineMs = now.getTime() + seconds * 1000;
  } else {
    deadlineMs = Date.parse(trimmed);
  }

  const distance = deadlineMs - now.getTime();
  if (!Number.isFinite(deadlineMs) || distance <= 0 || distance > MAX_RETRY_AFTER_MS) return null;
  return new Date(deadlineMs);
}

// Some gateways put the reset deadline in JSON instead of Retry-After. A missing/malformed
// deadline still requires a shared pause, rather than spending a retry for every waiting document.
export function throttledOrUnavailable(
  service: ServiceName,
  retryAfter: string | null,
  now = new Date(),
  body?: string,
): ServiceUnavailableError {
  const deadline = parseRetryAfter(retryAfter, now) ?? bodyRetryAfter(body, now);
  return new ServiceThrottledError(service, deadline ?? new Date(now.getTime() + 60_000));
}

function bodyRetryAfter(body: string | undefined, now: Date): Date | null {
  if (body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  // Never execute or interpret the error message. Only these machine-readable fields are used.
  const deadlines: Date[] = [];
  for (const key of ['retry_after_seconds', 'reset_at', 'blocked_until']) {
    const value: unknown = Reflect.get(parsed, key);
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const deadlineMs =
      key === 'retry_after_seconds'
        ? now.getTime() + Number(value) * 1000
        : Date.parse(String(value));
    const distance = deadlineMs - now.getTime();
    if (!Number.isFinite(deadlineMs) || distance <= 0) continue;
    deadlines.push(new Date(now.getTime() + Math.min(distance, MAX_RETRY_AFTER_MS)));
  }
  return deadlines.length === 0
    ? null
    : new Date(Math.max(...deadlines.map((date) => date.getTime())));
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
