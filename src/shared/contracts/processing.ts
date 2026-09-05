import { z } from 'zod';
import { documentStepSchema } from './documents';
import { stepStatusSchema } from './enums';
import {
  QUEUE_CONCURRENCY_MAX,
  SERVICE_COOLDOWN_MAX_SECONDS,
  SERVICE_NAMES,
  serviceGateStateSchema,
  storageUsageSchema,
  vectorCountsSchema,
} from './queue';

// The control plane names the three kinds of things it coordinates without pretending they are
// one runtime primitive. Queue workers, document steps and service gates keep their own semantics.
export const PROCESSING_QUEUE_NAMES = [
  'library-scan',
  'file-ingest',
  'document-process',
  'maintenance',
] as const;
export const processingQueueNameSchema = z.enum(PROCESSING_QUEUE_NAMES);
export type ProcessingQueueName = z.infer<typeof processingQueueNameSchema>;

export const processingSettingSourceSchema = z.enum(['DEFAULT', 'OVERRIDE']);
export type ProcessingSettingSource = z.infer<typeof processingSettingSourceSchema>;

export const resolvedNumberSettingSchema = z.object({
  effective: z.number().int().nonnegative(),
  default: z.number().int().nonnegative(),
  source: processingSettingSourceSchema,
});
export type ResolvedNumberSettingDto = z.infer<typeof resolvedNumberSettingSchema>;

export const resolvedBooleanSettingSchema = z.object({
  effective: z.boolean(),
  default: z.literal(false),
  source: processingSettingSourceSchema,
});
export type ResolvedBooleanSettingDto = z.infer<typeof resolvedBooleanSettingSchema>;

export const processingDependencySchema = z.object({
  step: documentStepSchema,
  kind: z.enum(['ARTIFACT', 'CONDITIONAL_TYPE']),
  holdWhen: z.enum(['UPSTREAM_UNSETTLED', 'UPSTREAM_UNSETTLED_AND_TYPE_MISSING']),
});
export type ProcessingDependencyDto = z.infer<typeof processingDependencySchema>;

export const processingResourceSchema = z.object({
  service: z.enum(SERVICE_NAMES),
  role: z.enum(['PRIMARY', 'FALLBACK', 'OPTIONAL', 'AUXILIARY']),
  when: z.enum([
    'ALWAYS',
    'WHEN_CONFIGURED',
    'WHEN_PRIMARY_UNCONFIGURED',
    'WHEN_OCR_USED',
    'WHEN_PAGE_IMAGES_USED',
  ]),
});
export type ProcessingResourceDto = z.infer<typeof processingResourceSchema>;

export const processingTopologySchema = z.object({
  version: z.literal(1),
  queues: z.array(
    z.object({
      name: processingQueueNameSchema,
      kind: z.enum(['INGRESS', 'PIPELINE', 'HOUSEKEEPING']),
      produces: z.array(processingQueueNameSchema),
      concurrencyConfigurable: z.literal(true),
      policy: z.enum(['stately', 'short', 'standard']),
      expireInSeconds: z.number().int().positive(),
    }),
  ),
  pipeline: z.object({
    queue: z.literal('document-process'),
    steps: z.array(
      z.object({
        step: documentStepSchema,
        dependencies: z.array(processingDependencySchema),
        resources: z.array(processingResourceSchema),
      }),
    ),
  }),
  services: z.array(
    z.object({
      service: z.enum(SERVICE_NAMES),
      steps: z.array(documentStepSchema),
      otherConsumers: z.array(z.string()),
    }),
  ),
});
export type ProcessingTopologyDto = z.infer<typeof processingTopologySchema>;

const queuePausedBlockerSchema = z.object({
  kind: z.literal('QUEUE_PAUSED'),
  queue: processingQueueNameSchema,
});
const stepPausedBlockerSchema = z.object({
  kind: z.literal('STEP_PAUSED'),
  step: documentStepSchema,
});
const dependencyPausedBlockerSchema = z.object({
  kind: z.literal('DEPENDENCY_PAUSED'),
  step: documentStepSchema,
  path: z.array(documentStepSchema).min(2),
  condition: z.enum(['UPSTREAM_UNSETTLED', 'UPSTREAM_UNSETTLED_AND_TYPE_MISSING']),
});

// The signed-in document view may name only controls which can hold that document. Runtime apply
// diagnostics belong to the administrative snapshot and are deliberately not part of this shape.
export const documentProcessingBlockerSchema = z.discriminatedUnion('kind', [
  queuePausedBlockerSchema,
  stepPausedBlockerSchema,
  dependencyPausedBlockerSchema,
]);
export type DocumentProcessingBlockerDto = z.infer<typeof documentProcessingBlockerSchema>;

export const documentProcessingStateSchema = z.object({
  // Explicit switches, not their cascade. Kept in topology order so a simple client may still
  // render the old "paused steps" summary without learning the dependency graph.
  pausedSteps: z.array(documentStepSchema),
  steps: z.array(
    z.object({
      step: documentStepSchema,
      blockers: z.array(documentProcessingBlockerSchema),
    }),
  ),
});
export type DocumentProcessingStateResponse = z.infer<typeof documentProcessingStateSchema>;

export const processingBlockerSchema = z.discriminatedUnion('kind', [
  queuePausedBlockerSchema,
  stepPausedBlockerSchema,
  dependencyPausedBlockerSchema,
  z.object({ kind: z.literal('RUNTIME_DEGRADED'), detail: z.string() }),
]);
export type ProcessingBlockerDto = z.infer<typeof processingBlockerSchema>;

export const processingControlsSchema = z.object({
  revision: z.number().int().nonnegative(),
  queues: z.array(
    z.object({
      name: processingQueueNameSchema,
      paused: resolvedBooleanSettingSchema,
      concurrency: resolvedNumberSettingSchema,
    }),
  ),
  pipeline: z.object({
    unitConcurrency: resolvedNumberSettingSchema,
    steps: z.array(z.object({ step: documentStepSchema, paused: resolvedBooleanSettingSchema })),
  }),
  services: z.array(
    z.object({
      service: z.enum(SERVICE_NAMES),
      concurrency: resolvedNumberSettingSchema,
      cooldownSeconds: resolvedNumberSettingSchema,
    }),
  ),
});
export type ProcessingControlsDto = z.infer<typeof processingControlsSchema>;

export const processingApplyStateSchema = z.object({
  status: z.enum(['APPLIED', 'APPLIED_WITH_WARNINGS', 'DEGRADED']),
  desiredRevision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  detail: z.string().nullable(),
});
export type ProcessingApplyStateDto = z.infer<typeof processingApplyStateSchema>;

const queueRuntimeSchema = z.object({
  registered: z.boolean(),
  appliedConcurrency: z.number().int().positive().nullable(),
  queued: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  failedRecent: z.number().int().nonnegative(),
  oldestQueuedAt: z.string().datetime().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
  completedLastHour: z.number().int().nonnegative(),
});

const healthSnapshotSchema = z.object({
  freshness: z.enum(['UNKNOWN', 'FRESH', 'STALE']),
  value: z
    .object({
      url: z.string(),
      status: z.enum(['UP', 'UNAUTHORIZED', 'ANSWERED', 'DOWN', 'NOT_CONFIGURED']),
      httpStatus: z.number().int().nullable(),
      latencyMs: z.number().int().nonnegative().nullable(),
      checkedAt: z.string().datetime(),
      detail: z.string().nullable(),
    })
    .nullable(),
});

export const processingSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
  apply: processingApplyStateSchema,
  topology: processingTopologySchema,
  queues: z.array(
    z.object({
      name: processingQueueNameSchema,
      control: z.object({
        paused: resolvedBooleanSettingSchema,
        concurrency: resolvedNumberSettingSchema,
      }),
      runtime: queueRuntimeSchema,
      blockers: z.array(processingBlockerSchema),
    }),
  ),
  pipeline: z.object({
    queue: z.literal('document-process'),
    unitConcurrency: resolvedNumberSettingSchema,
    totalDocuments: z.number().int().nonnegative(),
    steps: z.array(
      z.object({
        step: documentStepSchema,
        control: z.object({ paused: resolvedBooleanSettingSchema }),
        counts: z.record(stepStatusSchema, z.number().int().nonnegative()),
        blockers: z.array(processingBlockerSchema),
      }),
    ),
  }),
  services: z.array(
    z.object({
      service: z.enum(SERVICE_NAMES),
      control: z.object({
        concurrency: resolvedNumberSettingSchema,
        cooldownSeconds: resolvedNumberSettingSchema,
      }),
      gate: serviceGateStateSchema,
      health: healthSnapshotSchema,
    }),
  ),
  vectors: vectorCountsSchema,
  storage: storageUsageSchema.nullable(),
});
export type ProcessingSnapshotResponse = z.infer<typeof processingSnapshotSchema>;

const expectedRevisionSchema = z.number().int().nonnegative();
const atLeastOne = (value: object): boolean =>
  Object.keys(value).some((key) => key !== 'expectedRevision');

export const updateProcessingQueueRequestSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    concurrency: z.number().int().min(1).max(QUEUE_CONCURRENCY_MAX).nullable().optional(),
    paused: z.boolean().optional(),
  })
  .refine(atLeastOne, { message: 'At least one setting must be supplied' });
export type UpdateProcessingQueueRequest = z.infer<typeof updateProcessingQueueRequestSchema>;

export const updateProcessingPipelineRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  unitConcurrency: z.number().int().min(1).max(QUEUE_CONCURRENCY_MAX).nullable(),
});
export type UpdateProcessingPipelineRequest = z.infer<typeof updateProcessingPipelineRequestSchema>;

export const updateProcessingStepRequestSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  paused: z.boolean(),
});
export type UpdateProcessingStepRequest = z.infer<typeof updateProcessingStepRequestSchema>;

export const updateProcessingServiceRequestSchema = z
  .object({
    expectedRevision: expectedRevisionSchema,
    concurrency: z.number().int().min(0).max(QUEUE_CONCURRENCY_MAX).nullable().optional(),
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(SERVICE_COOLDOWN_MAX_SECONDS)
      .nullable()
      .optional(),
  })
  .refine(atLeastOne, { message: 'At least one setting must be supplied' });
export type UpdateProcessingServiceRequest = z.infer<typeof updateProcessingServiceRequestSchema>;

export const processingCommandResultSchema = z.object({
  revision: z.number().int().nonnegative(),
  changed: z.boolean(),
  apply: processingApplyStateSchema,
  controls: processingControlsSchema,
  resumed: z.array(
    z.object({
      step: documentStepSchema,
      documents: z.number().int().nonnegative(),
      hasMore: z.boolean(),
    }),
  ),
});
export type ProcessingCommandResult = z.infer<typeof processingCommandResultSchema>;

export type ProcessingSettingsCommand =
  | ({ kind: 'queue'; queue: ProcessingQueueName } & UpdateProcessingQueueRequest)
  | ({ kind: 'pipeline' } & UpdateProcessingPipelineRequest)
  | ({ kind: 'step'; step: z.infer<typeof documentStepSchema> } & UpdateProcessingStepRequest)
  | ({ kind: 'service'; service: (typeof SERVICE_NAMES)[number] } & UpdateProcessingServiceRequest);
