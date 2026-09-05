import {
  SERVICE_NAMES,
  type ServiceHealthDto,
  type ServiceName,
  type ServicesHealthResponse,
} from '../../../shared/contracts/queue';
import type { Clock } from '../ports/clock';
import type { ExternalServiceProbe } from './ports';

// How long an answer stands. Every open admin tab asks for this, and each ask leaves the instance
// five times — so a few seconds of holding is what keeps a reloading page from adding to the load on
// a container that may already be the reason somebody is reloading (docs/05 §5.4c). Short enough
// that a container coming back up is seen within a breath of pressing Check.
const FRESH_FOR_MS = 5_000;

// A reason is a sentence, not a stack trace: this one ends up in a tooltip.
const MAX_DETAIL_CHARS = 300;

// CheckExternalServices (docs/05 §5.4c, docs/07 §7.3): where each gated service is and whether it
// answers. Framework-free — the probing itself is a port, so this is testable without a network.
export class CheckExternalServices {
  private answered: { at: number; data: ServicesHealthResponse } | null = null;
  // The check in flight, if there is one: two tabs arriving together should cost one round of probes
  // rather than one each, and they want the same answer anyway.
  private inFlight: Promise<ServicesHealthResponse> | null = null;

  constructor(
    private readonly probe: ExternalServiceProbe,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<ServicesHealthResponse> {
    const answered = this.answered;
    if (answered !== null && this.clock.now().getTime() - answered.at < FRESH_FOR_MS) {
      return answered.data;
    }

    this.inFlight ??= this.check().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  // A control-plane snapshot must stay a local read: opening the processing screen during an
  // outage must not wait for five network timeouts. Probing remains an explicit endpoint.
  peek(): {
    freshness: 'UNKNOWN' | 'FRESH' | 'STALE';
    data: ServicesHealthResponse | null;
  } {
    const answered = this.answered;
    if (answered === null) return { freshness: 'UNKNOWN', data: null };
    return {
      freshness: this.clock.now().getTime() - answered.at < FRESH_FOR_MS ? 'FRESH' : 'STALE',
      data: answered.data,
    };
  }

  private async check(): Promise<ServicesHealthResponse> {
    const checkedAt = this.clock.now();
    // 🔒 In parallel and never in sequence: five services that have all stopped answering must cost
    // one timeout, not five, or the screen an operator opens during an outage is the screen that
    // takes half a minute to draw.
    const services = await Promise.all(
      SERVICE_NAMES.map((service) => this.one(service, checkedAt.toISOString())),
    );
    const data: ServicesHealthResponse = { services };
    this.answered = { at: checkedAt.getTime(), data };
    return data;
  }

  // 🔒 One probe that throws must not take the other four with it: the answer to "which of my
  // services are up" is not "an error page" because one adapter had a bad day. A throw is the same
  // news as a refusal — nothing came back — so it is reported as such rather than swallowed.
  private async one(service: ServiceName, checkedAt: string): Promise<ServiceHealthDto> {
    try {
      const result = await this.probe.check(service);
      return { service, checkedAt, ...result };
    } catch (error) {
      return {
        service,
        checkedAt,
        url: '',
        status: 'DOWN',
        httpStatus: null,
        latencyMs: null,
        detail: truncate(error instanceof Error ? error.message : String(error)),
      };
    }
  }
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_CHARS ? text : `${text.slice(0, MAX_DETAIL_CHARS)}…`;
}
