import type { ServiceHealthStatus, ServiceName } from '../../../shared/contracts/queue';

// Application ports for the health check (docs/06 §6.10). Implemented in infrastructure so the use
// case stays framework-free and the components (DB, queue) can be swapped/mocked.
export abstract class DbHealthChecker {
  abstract ping(): Promise<boolean>;
}

export abstract class QueueHealthChecker {
  abstract status(): Promise<'ok' | 'down'>;
}

// What one look at one external service came back with (docs/05 §5.4c). Where it was asked is part
// of the answer, because the panel publishes the address as well as the verdict — an address that is
// not the one being called would be worse than none.
export type ServiceProbeResult = {
  // 🔒 Published: any userinfo already stripped, and never an API key. Empty where nothing is
  // configured.
  readonly url: string;
  readonly status: ServiceHealthStatus;
  readonly httpStatus: number | null;
  readonly latencyMs: number | null;
  readonly detail: string | null;
};

// Asking an external service whether it is there. Implemented in infrastructure because the asking
// is HTTP and the use case has no business knowing that — and because what counts as a cheap
// question differs per service (docs/05 §5.4c).
export abstract class ExternalServiceProbe {
  abstract check(service: ServiceName): Promise<ServiceProbeResult>;
}
