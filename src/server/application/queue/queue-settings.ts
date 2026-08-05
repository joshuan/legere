import {
  QUEUE_CONCURRENCY_MAX,
  type QueueSettingsDto,
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
};

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
    const value = {
      concurrency,
      unitConcurrency: clamp(input.unitConcurrency),
      // Same rule as the concurrencies: only queues that exist. A paused name nobody serves would
      // sit in the settings row for ever, pausing nothing (docs/05 §5.4).
      paused: knownQueues(input.paused),
    };
    await this.settings.write(QUEUE_SETTINGS_KEY, value);
    return value;
  }
}

function clamp(value: number): number {
  return Math.min(QUEUE_CONCURRENCY_MAX, Math.max(1, Math.trunc(value)));
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
    ...(typeof unit === 'number' && Number.isInteger(unit) && unit >= 1
      ? { unitConcurrency: unit }
      : {}),
  };
}
