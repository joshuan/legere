import { DOCUMENT_STEPS, type DocumentStep } from '../../../shared/contracts/documents';
import {
  type ProcessingControlsDto,
  type ProcessingSettingsCommand,
  type ResolvedBooleanSettingDto,
  type ResolvedNumberSettingDto,
} from '../../../shared/contracts/processing';
import {
  QUEUE_CONCURRENCY_MAX,
  SERVICE_COOLDOWN_MAX_SECONDS,
  SERVICE_NAMES,
  type QueueSettingsDto,
  type ServiceGateDto,
  type ServiceName,
  type UpdateQueueSettingsRequest,
} from '../../../shared/contracts/queue';
import type {
  SettingValue,
  SettingsRepository,
} from '../../domain/repositories/settings.repository';
import { ConflictError } from '../../domain/errors/domain-error';
import { QUEUE_NAMES, type QueueName } from '../ports/job-queue';

export const QUEUE_SETTINGS_KEY = 'queue';
const SETTINGS_SCHEMA_VERSION = 2;

export type QueueDefaults = {
  concurrency: Record<QueueName, number>;
  unitConcurrency: number;
  services: Record<ServiceName, ServiceGateDto>;
};

type QueueSettingsOverrides = {
  concurrency: Partial<Record<QueueName, number>>;
  unitConcurrency?: number;
  paused: QueueName[];
  pausedSteps: DocumentStep[];
  services: Partial<Record<ServiceName, Partial<ServiceGateDto>>>;
};

export type QueueSettingsState = {
  revision: number;
  effective: QueueSettingsDto;
  controls: ProcessingControlsDto;
  // Needed by compensation: restoring effective values alone would turn inherited defaults into
  // overrides and lie about their source.
  overrides: QueueSettingsOverrides;
};

export type QueueSettingsChange = {
  before: QueueSettingsState;
  after: QueueSettingsState;
  changed: boolean;
};

export function ungatedServices(): Record<ServiceName, ServiceGateDto> {
  return {
    stirling: { concurrency: 0, cooldownSeconds: 0 },
    docling: { concurrency: 0, cooldownSeconds: 0 },
    classifier: { concurrency: 0, cooldownSeconds: 0 },
    transcriber: { concurrency: 0, cooldownSeconds: 0 },
    embeddings: { concurrency: 0, cooldownSeconds: 0 },
  };
}

// Persistence and default resolution. Applying the desired state to pg-boss and the live gates is
// deliberately left to ProcessingControlPlane.
export class QueueSettings {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly defaults: QueueDefaults,
  ) {}

  async read(): Promise<QueueSettingsDto> {
    return (await this.readState()).effective;
  }

  async readResolved(): Promise<ProcessingControlsDto> {
    return (await this.readState()).controls;
  }

  async readState(): Promise<QueueSettingsState> {
    const parsed = parse(await this.settings.read(QUEUE_SETTINGS_KEY));
    return this.resolve(parsed?.overrides ?? emptyOverrides(), parsed?.revision ?? 0);
  }

  // Compatibility for the old whole-form endpoint. Supplied numbers are explicit overrides;
  // omitted queue and service keys continue to inherit their defaults.
  async write(input: UpdateQueueSettingsRequest): Promise<QueueSettingsDto> {
    return (await this.replace(input)).after.effective;
  }

  async replace(input: UpdateQueueSettingsRequest): Promise<QueueSettingsChange> {
    const before = await this.readState();
    const overrides: QueueSettingsOverrides = {
      concurrency: Object.fromEntries(
        QUEUE_NAMES.flatMap((queue) => {
          const value = input.concurrency[queue];
          return value === undefined ? [] : [[queue, clamp(value)]];
        }),
      ),
      unitConcurrency: clamp(input.unitConcurrency),
      paused: knownQueues(input.paused),
      pausedSteps: knownSteps(input.pausedSteps),
      services: Object.fromEntries(
        SERVICE_NAMES.flatMap((service) => {
          const value = input.services[service];
          return value === undefined ? [] : [[service, clampGate(value)]];
        }),
      ),
    };
    if (sameOverrides(before.overrides, overrides))
      return { before, after: before, changed: false };
    const after = this.resolve(overrides, before.revision + 1);
    await this.persist(after);
    return { before, after, changed: true };
  }

  async apply(command: ProcessingSettingsCommand): Promise<QueueSettingsChange> {
    const before = await this.readState();
    if (before.revision !== command.expectedRevision) {
      throw new ConflictError(
        'PROCESSING_SETTINGS_CHANGED',
        'Processing settings changed; read the current revision and try again',
      );
    }
    const overrides = cloneOverrides(before.overrides);

    if (command.kind === 'queue') {
      if (command.concurrency !== undefined) {
        if (command.concurrency === null) delete overrides.concurrency[command.queue];
        else overrides.concurrency[command.queue] = command.concurrency;
      }
      if (command.paused !== undefined) {
        overrides.paused = toggled(QUEUE_NAMES, overrides.paused, command.queue, command.paused);
      }
    } else if (command.kind === 'pipeline') {
      if (command.unitConcurrency === null) delete overrides.unitConcurrency;
      else overrides.unitConcurrency = command.unitConcurrency;
    } else if (command.kind === 'step') {
      overrides.pausedSteps = toggled(
        DOCUMENT_STEPS,
        overrides.pausedSteps,
        command.step,
        command.paused,
      );
    } else {
      const gate = { ...(overrides.services[command.service] ?? {}) };
      if (command.concurrency !== undefined) {
        if (command.concurrency === null) delete gate.concurrency;
        else gate.concurrency = command.concurrency;
      }
      if (command.cooldownSeconds !== undefined) {
        if (command.cooldownSeconds === null) delete gate.cooldownSeconds;
        else gate.cooldownSeconds = command.cooldownSeconds;
      }
      if (Object.keys(gate).length === 0) delete overrides.services[command.service];
      else overrides.services[command.service] = gate;
    }

    if (sameOverrides(before.overrides, overrides))
      return { before, after: before, changed: false };

    const after = this.resolve(overrides, before.revision + 1);
    await this.persist(after);
    return { before, after, changed: true };
  }

  // A rollback is a new write and therefore gets a new revision. A client which observed the
  // candidate revision cannot later use it to overwrite the restored state.
  async restore(before: QueueSettingsState): Promise<QueueSettingsState> {
    const current = await this.readState();
    const restored = this.resolve(cloneOverrides(before.overrides), current.revision + 1);
    await this.persist(restored);
    return restored;
  }

  async heldSteps(): Promise<ReadonlySet<DocumentStep>> {
    const paused = (await this.read()).pausedSteps;
    return new Set(DOCUMENT_STEPS.filter((step) => paused.includes(step)));
  }

  private resolve(overrides: QueueSettingsOverrides, revision: number): QueueSettingsState {
    const effective: QueueSettingsDto = {
      concurrency: Object.fromEntries(
        QUEUE_NAMES.map((queue) => [
          queue,
          overrides.concurrency[queue] ?? this.defaults.concurrency[queue],
        ]),
      ),
      unitConcurrency: overrides.unitConcurrency ?? this.defaults.unitConcurrency,
      paused: [...overrides.paused],
      pausedSteps: [...overrides.pausedSteps],
      services: Object.fromEntries(
        SERVICE_NAMES.map((service) => [
          service,
          gateOf(overrides.services[service], this.defaults.services[service]),
        ]),
      ),
    };
    const controls: ProcessingControlsDto = {
      revision,
      queues: QUEUE_NAMES.map((name) => ({
        name,
        paused: resolvedBoolean(overrides.paused.includes(name)),
        concurrency: resolvedNumber(
          effective.concurrency[name] ?? this.defaults.concurrency[name],
          this.defaults.concurrency[name],
          overrides.concurrency[name] !== undefined,
        ),
      })),
      pipeline: {
        unitConcurrency: resolvedNumber(
          effective.unitConcurrency,
          this.defaults.unitConcurrency,
          overrides.unitConcurrency !== undefined,
        ),
        steps: DOCUMENT_STEPS.map((step) => ({
          step,
          paused: resolvedBoolean(overrides.pausedSteps.includes(step)),
        })),
      },
      services: SERVICE_NAMES.map((service) => ({
        service,
        concurrency: resolvedNumber(
          effective.services[service]?.concurrency ?? this.defaults.services[service].concurrency,
          this.defaults.services[service].concurrency,
          overrides.services[service]?.concurrency !== undefined,
        ),
        cooldownSeconds: resolvedNumber(
          effective.services[service]?.cooldownSeconds ??
            this.defaults.services[service].cooldownSeconds,
          this.defaults.services[service].cooldownSeconds,
          overrides.services[service]?.cooldownSeconds !== undefined,
        ),
      })),
    };
    return { revision, effective, controls, overrides: cloneOverrides(overrides) };
  }

  private async persist(state: QueueSettingsState): Promise<void> {
    const stored: SettingValue = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      revision: state.revision,
      ...(Object.keys(state.overrides.concurrency).length === 0
        ? {}
        : { concurrency: state.overrides.concurrency }),
      ...(state.overrides.unitConcurrency === undefined
        ? {}
        : { unitConcurrency: state.overrides.unitConcurrency }),
      ...(state.overrides.paused.length === 0 ? {} : { paused: state.overrides.paused }),
      ...(state.overrides.pausedSteps.length === 0
        ? {}
        : { pausedSteps: state.overrides.pausedSteps }),
      ...(Object.keys(state.overrides.services).length === 0
        ? {}
        : { services: state.overrides.services }),
    };
    await this.settings.write(QUEUE_SETTINGS_KEY, stored);
  }
}

function resolvedNumber(
  effective: number,
  fallback: number,
  overridden: boolean,
): ResolvedNumberSettingDto {
  return { effective, default: fallback, source: overridden ? 'OVERRIDE' : 'DEFAULT' };
}

function resolvedBoolean(overridden: boolean): ResolvedBooleanSettingDto {
  return { effective: overridden, default: false, source: overridden ? 'OVERRIDE' : 'DEFAULT' };
}

function emptyOverrides(): QueueSettingsOverrides {
  return { concurrency: {}, paused: [], pausedSteps: [], services: {} };
}

function cloneOverrides(value: QueueSettingsOverrides): QueueSettingsOverrides {
  return {
    concurrency: { ...value.concurrency },
    ...(value.unitConcurrency === undefined ? {} : { unitConcurrency: value.unitConcurrency }),
    paused: [...value.paused],
    pausedSteps: [...value.pausedSteps],
    services: Object.fromEntries(
      SERVICE_NAMES.flatMap((service) => {
        const gate = value.services[service];
        return gate === undefined ? [] : [[service, { ...gate }]];
      }),
    ),
  };
}

function sameOverrides(left: QueueSettingsOverrides, right: QueueSettingsOverrides): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function toggled<T extends string>(
  order: readonly T[],
  current: readonly T[],
  value: T,
  enabled: boolean,
): T[] {
  const selected = new Set(current);
  if (enabled) selected.add(value);
  else selected.delete(value);
  return order.filter((entry) => selected.has(entry));
}

function clamp(value: number): number {
  return Math.min(QUEUE_CONCURRENCY_MAX, Math.max(1, Math.trunc(value)));
}

function clampGate(gate: ServiceGateDto): ServiceGateDto {
  return {
    concurrency: bound(gate.concurrency, QUEUE_CONCURRENCY_MAX),
    cooldownSeconds: bound(gate.cooldownSeconds, SERVICE_COOLDOWN_MAX_SECONDS),
  };
}

function bound(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.trunc(value)));
}

function gateOf(
  stored: Partial<ServiceGateDto> | undefined,
  fallback: ServiceGateDto,
): ServiceGateDto {
  return {
    concurrency: stored?.concurrency ?? fallback.concurrency,
    cooldownSeconds: stored?.cooldownSeconds ?? fallback.cooldownSeconds,
  };
}

function knownQueues(value: unknown): QueueName[] {
  if (!Array.isArray(value)) return [];
  const named = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  return QUEUE_NAMES.filter((queue) => named.has(queue));
}

function knownSteps(value: unknown): DocumentStep[] {
  if (!Array.isArray(value)) return [];
  const named = new Set(value.filter((entry): entry is string => typeof entry === 'string'));
  return DOCUMENT_STEPS.filter((step) => named.has(step));
}

function parse(value: unknown): { revision: number; overrides: QueueSettingsOverrides } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record: Record<string, unknown> = { ...value };
  const concurrency: Partial<Record<QueueName, number>> = {};
  const storedConcurrency = record.concurrency;
  if (
    storedConcurrency !== null &&
    typeof storedConcurrency === 'object' &&
    !Array.isArray(storedConcurrency)
  ) {
    const values: Record<string, unknown> = { ...storedConcurrency };
    for (const queue of QUEUE_NAMES) {
      const raw = values[queue];
      if (inConcurrencyRange(raw)) concurrency[queue] = raw;
    }
  }

  const unit = record.unitConcurrency;
  const revision =
    record.schemaVersion === SETTINGS_SCHEMA_VERSION &&
    typeof record.revision === 'number' &&
    Number.isInteger(record.revision) &&
    record.revision >= 0
      ? record.revision
      : 0;
  return {
    revision,
    overrides: {
      concurrency,
      ...(inConcurrencyRange(unit) ? { unitConcurrency: unit } : {}),
      paused: knownQueues(record.paused),
      pausedSteps: knownSteps(record.pausedSteps),
      services: parseServices(record.services),
    },
  };
}

function inConcurrencyRange(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= QUEUE_CONCURRENCY_MAX
  );
}

function parseServices(value: unknown): Partial<Record<ServiceName, Partial<ServiceGateDto>>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const records: Record<string, unknown> = { ...value };
  const services: Partial<Record<ServiceName, Partial<ServiceGateDto>>> = {};
  for (const service of SERVICE_NAMES) {
    const raw = records[service];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const gate: Record<string, unknown> = { ...raw };
    const parsed = {
      ...(inRange(gate.concurrency, QUEUE_CONCURRENCY_MAX)
        ? { concurrency: gate.concurrency }
        : {}),
      ...(inRange(gate.cooldownSeconds, SERVICE_COOLDOWN_MAX_SECONDS)
        ? { cooldownSeconds: gate.cooldownSeconds }
        : {}),
    };
    if (Object.keys(parsed).length > 0) services[service] = parsed;
  }
  return services;
}

function inRange(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}
