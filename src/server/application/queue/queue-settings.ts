import {
  QUEUE_CONCURRENCY_MAX,
  SERVICE_COOLDOWN_MAX_SECONDS,
  SERVICE_NAMES,
  type QueueSettingsDto,
  type ServiceGateDto,
  type ServiceName,
  type UpdateQueueSettingsRequest,
} from '../../../shared/contracts/queue';
import type { SettingsRepository } from '../../domain/repositories/settings.repository';
import { QUEUE_NAMES, type QueueName } from '../ports/job-queue';

// The one key these live under; the table is a general store (docs/03 §3.3.21).
export const QUEUE_SETTINGS_KEY = 'queue';

// What a queue does when nobody has said otherwise: the env values of docs/12 §12.4. A setting row
// is somebody overriding one deliberately, so the defaults stay where they always were.
export type QueueDefaults = {
  concurrency: Record<QueueName, number>;
  unitConcurrency: number;
  // The gates of docs/05 §5.4b, from `SERVICE_CONCURRENCY_*` / `SERVICE_COOLDOWN_*`. Zeroes unless
  // an operator wrote otherwise, and zeroes are no gate at all.
  services: Record<ServiceName, ServiceGateDto>;
};

// Every gate off, which is what `SERVICE_CONCURRENCY_*` and `SERVICE_COOLDOWN_*` resolve to when
// nobody has set them: an instance that upgrades into gating waits nowhere (docs/05 §5.4b).
export function ungatedServices(): Record<ServiceName, ServiceGateDto> {
  return {
    stirling: { concurrency: 0, cooldownSeconds: 0 },
    docling: { concurrency: 0, cooldownSeconds: 0 },
    classifier: { concurrency: 0, cooldownSeconds: 0 },
    transcriber: { concurrency: 0, cooldownSeconds: 0 },
    embeddings: { concurrency: 0, cooldownSeconds: 0 },
  };
}

// Reading is not an admin-only operation in the domain sense — the worker registry reads it on every
// restart — so this is a plain service rather than a use case pair.
export class QueueSettings {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly defaults: QueueDefaults,
  ) {}

  async read(): Promise<QueueSettingsDto> {
    const stored = await this.settings.read(QUEUE_SETTINGS_KEY);
    const overrides = parse(stored);

    return {
      concurrency: Object.fromEntries(
        QUEUE_NAMES.map((queue) => [
          queue,
          overrides?.concurrency?.[queue] ?? this.defaults.concurrency[queue],
        ]),
      ),
      unitConcurrency: overrides?.unitConcurrency ?? this.defaults.unitConcurrency,
      // Nothing is paused until somebody pauses it: an instance with an empty settings table works
      // every queue it has (docs/05 §5.4).
      paused: overrides?.paused ?? [],
      services: Object.fromEntries(
        SERVICE_NAMES.map((service) => [
          service,
          gateOf(overrides?.services?.[service], this.defaults.services[service]),
        ]),
      ),
    };
  }

  async write(input: UpdateQueueSettingsRequest): Promise<QueueSettingsDto> {
    // Only the queues that exist, and only within bounds: a stored key nobody serves would sit there
    // forever looking like a setting that does nothing.
    const concurrency = Object.fromEntries(
      QUEUE_NAMES.map((queue) => [
        queue,
        clamp(input.concurrency[queue] ?? this.defaults.concurrency[queue]),
      ]),
    );
    // The same hygiene one level down (docs/05 §5.4b): a service this version does not gate is
    // dropped. The clamp is belt-and-braces behind the contract, which has already refused anything
    // out of range (docs/07 §7.3) — what it really bounds is the env defaults standing in for an
    // absent override.
    const services = Object.fromEntries(
      SERVICE_NAMES.map((service) => [
        service,
        clampGate(input.services[service] ?? this.defaults.services[service]),
      ]),
    );
    const value = {
      concurrency,
      unitConcurrency: clamp(input.unitConcurrency),
      // Same rule as the concurrencies: only queues that exist. A paused name nobody serves would
      // sit in the settings row for ever, pausing nothing (docs/05 §5.4).
      paused: knownQueues(input.paused),
      services,
    };
    await this.settings.write(QUEUE_SETTINGS_KEY, value);
    return value;
  }
}

function clamp(value: number): number {
  return Math.min(QUEUE_CONCURRENCY_MAX, Math.max(1, Math.trunc(value)));
}

// A gate has its own floor, and it is 0: a service concurrency of zero is a meaningful answer — no
// gate at all — where a queue concurrency of zero would be a queue nobody serves (docs/05 §5.4b).
function clampGate(gate: ServiceGateDto): ServiceGateDto {
  return {
    concurrency: bound(gate.concurrency, QUEUE_CONCURRENCY_MAX),
    cooldownSeconds: bound(gate.cooldownSeconds, SERVICE_COOLDOWN_MAX_SECONDS),
  };
}

function bound(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

// What is stored for one service over what the environment said, knob by knob: an override that
// carries only a cooldown leaves the concurrency where env put it.
function gateOf(
  stored: Partial<ServiceGateDto> | undefined,
  fallback: ServiceGateDto,
): ServiceGateDto {
  return {
    concurrency: stored?.concurrency ?? fallback.concurrency,
    cooldownSeconds: stored?.cooldownSeconds ?? fallback.cooldownSeconds,
  };
}

// The queues named here that this version actually has, deduplicated and in pipeline order. A name
// it does not know is dropped rather than kept: a queue removed by an upgrade, or a typo, must not
// become a setting that does nothing for ever.
function knownQueues(value: unknown): QueueName[] {
  if (!Array.isArray(value)) return [];
  const named = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  return QUEUE_NAMES.filter((queue) => named.has(queue));
}

// Whatever is in the column has been in a database in between: a shape this version does not know is
// ignored rather than crashing the workers on start.
function parse(value: unknown): {
  concurrency?: Record<string, number>;
  unitConcurrency?: number;
  paused?: QueueName[];
  services?: Record<string, Partial<ServiceGateDto>>;
} | null {
  if (value === null || typeof value !== 'object') return null;
  const record: Record<string, unknown> = { ...value };

  const concurrency: Record<string, number> = {};
  const stored = record.concurrency;
  if (stored !== null && typeof stored === 'object') {
    for (const [queue, raw] of Object.entries({ ...stored })) {
      if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) concurrency[queue] = raw;
    }
  }

  const unit = record.unitConcurrency;
  return {
    concurrency,
    paused: knownQueues(record.paused),
    services: parseServices(record.services),
    ...(typeof unit === 'number' && Number.isInteger(unit) && unit >= 1
      ? { unitConcurrency: unit }
      : {}),
  };
}

// Knob by knob, and only the ones that read as a number in range: a stored gate written by a later
// version — or by hand — must not stop the workers from starting (docs/03 §3.3.21).
function parseServices(value: unknown): Record<string, Partial<ServiceGateDto>> {
  if (value === null || typeof value !== 'object') return {};

  const services: Record<string, Partial<ServiceGateDto>> = {};
  for (const [service, raw] of Object.entries({ ...value })) {
    if (raw === null || typeof raw !== 'object') continue;
    const gate: Record<string, unknown> = { ...raw };
    services[service] = {
      ...(inRange(gate.concurrency, QUEUE_CONCURRENCY_MAX)
        ? { concurrency: gate.concurrency }
        : {}),
      ...(inRange(gate.cooldownSeconds, SERVICE_COOLDOWN_MAX_SECONDS)
        ? { cooldownSeconds: gate.cooldownSeconds }
        : {}),
    };
  }
  return services;
}

function inRange(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}
