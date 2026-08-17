import {
  SERVICE_NAMES,
  type QueueSettingsDto,
  type ServiceGateDto,
  type ServiceGateStateDto,
  type ServiceName,
} from '../../../shared/contracts/queue';
import type { Clock } from '../ports/clock';

// One gate's state with the service it belongs to, which is how the overview lists them.
type ServiceGateStateSnapshot = ServiceGateStateDto & { service: ServiceName };

// The per-service gates of docs/05 §5.4b. The two knobs of §5.4 count jobs and units; this counts
// the thing that is actually scarce on a self-hosted box — calls to one container — so an operator
// can say "at most one OCR at a time" without also saying "at most one document at a time".
//
// A gate admits at most `concurrency` units of that service's work at once and, when a unit
// finishes, holds its slot shut for `cooldownSeconds` — after a success and after a failure alike,
// because a container that has just fallen over is the last one to hurry. Callers that find it shut
// wait in FIFO order, so a queue of them does not become a lottery.
//
// 🔒 `concurrency: 0` is not a semaphore of infinite width: it is no gate at all. Nothing is
// counted, nobody waits, and the cooldown has no slot to hold shut — which is what makes the
// default of `0`/`0` behave exactly as this product behaved before gates existed.

// A gate is held in the process, and one process is the whole of this instance (ADR-002).
class ServiceGate {
  constructor(private readonly clock: Clock) {}

  private concurrency = 0;
  private cooldownMs = 0;
  private inFlight = 0;
  // In arrival order, and served from the front: the document that arrived first is not starved by
  // the ones behind it. Each carries the moment it began waiting, which is the only number on this
  // screen an operator cannot infer from the others (docs/05 §5.4b).
  private readonly waiting: Array<{ admit: () => void; since: number }> = [];

  // Applied in place rather than at the next restart (docs/05 §5.4b): widening releases whoever is
  // already standing at the gate, and narrowing takes effect as slots come free — a unit in flight
  // is not interrupted for a number that changed under it.
  configure(gate: ServiceGateDto): void {
    this.concurrency = gate.concurrency;
    this.cooldownMs = gate.cooldownSeconds * 1000;
    this.admit();
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    // Read once: a caller that got in ungated must not start decrementing a counter it never
    // incremented because the gate closed while it was working.
    if (this.concurrency === 0) return work();

    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  // What this gate is doing this instant (docs/05 §5.4b): the answer to "is the throttle working",
  // which nothing else on the panel can give. A step waiting at a gate reads as `RUNNING` like a step
  // doing the work, so these three numbers are the only honest witness. Ungated says so with nulls
  // rather than with zeroes: nothing is being metered there, which is not the same as nothing waiting.
  snapshot(): ServiceGateStateDto {
    if (this.concurrency === 0) return { inFlight: 0, waiting: 0, longestWaitMs: 0, gated: false };
    const front = this.waiting[0];
    return {
      inFlight: this.inFlight,
      waiting: this.waiting.length,
      longestWaitMs: front === undefined ? 0 : this.clock.now().getTime() - front.since,
      gated: true,
    };
  }

  private acquire(): Promise<void> {
    // Nobody may overtake a queue that has already formed, however free the gate looks.
    if (this.waiting.length === 0 && this.inFlight < this.concurrency) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push({ admit: resolve, since: this.clock.now().getTime() });
    });
  }

  private release(): void {
    if (this.cooldownMs === 0) {
      this.free();
      return;
    }
    // The slot, not the caller: the unit is over and its result is on its way back, while the next
    // one waits out the pause the operator asked for.
    const timer = setTimeout(() => this.free(), this.cooldownMs);
    // A pause is not work: it must never be the reason a container takes ten minutes to stop.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
  }

  private free(): void {
    this.inFlight -= 1;
    this.admit();
  }

  // Everyone the gate can now hold, in the order they arrived. The slot is taken here rather than
  // in the resumed caller, so a newcomer arriving before that caller wakes up cannot take it first.
  private admit(): void {
    while (
      this.waiting.length > 0 &&
      (this.concurrency === 0 || this.inFlight < this.concurrency)
    ) {
      const next = this.waiting.shift();
      if (next === undefined) return;
      this.inFlight += 1;
      next.admit();
    }
  }
}

// One gate per service, reachable by name. Ungated until something configures it, which is what an
// instance with no stored settings and no `SERVICE_*` environment gets (docs/05 §5.4b).
export class ServiceGates {
  constructor(private readonly clock: Clock) {}

  private readonly gates = new Map<ServiceName, ServiceGate>(
    SERVICE_NAMES.map((service) => [service, new ServiceGate(this.clock)]),
  );

  // Everything the settings hold, in one call: this is what boot and every admin save both do, so
  // a knob that changed and a knob that did not travel together (docs/07 §7.3).
  configure(services: QueueSettingsDto['services']): void {
    for (const service of SERVICE_NAMES) {
      const gate = services[service];
      if (gate === undefined) continue;
      this.gates.get(service)?.configure(gate);
    }
  }

  // One unit of external work — one Stirling call, one whole Docling parse, one analyst call, one
  // transcription, one batch of embeddings (docs/05 §5.4b).
  async run<T>(service: ServiceName, work: () => Promise<T>): Promise<T> {
    const gate = this.gates.get(service);
    return gate === undefined ? work() : gate.run(work);
  }

  // Every gate, in the order the services are named, for the admin overview (docs/07 §7.3). Read off
  // the semaphores and stored nowhere: a number that had to be written down to be read would outlive
  // the truth it reports.
  snapshot(): ServiceGateStateSnapshot[] {
    return SERVICE_NAMES.map((service) => ({
      service,
      ...(this.gates.get(service)?.snapshot() ?? {
        inFlight: 0,
        waiting: 0,
        longestWaitMs: 0,
        gated: false,
      }),
    }));
  }
}
