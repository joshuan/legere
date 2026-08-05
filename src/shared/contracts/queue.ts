import { z } from 'zod';
import { stepStatusSchema } from './enums';
import { documentStepSchema } from './documents';

// Admin queue contracts (docs/07 §7.3 admin queue, docs/05 §5.8, docs/11 §11.13).

export const queueDepthSchema = z.object({
  name: z.string(),
  queued: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  failedRecent: z.number().int().nonnegative(),
});
export type QueueDepthDto = z.infer<typeof queueDepthSchema>;

// How many documents sit in each status of each pipeline step — the "is anything stuck?" view.
export const stepCountersSchema = z.object({
  step: documentStepSchema,
  counts: z.record(stepStatusSchema, z.number().int().nonnegative()),
});
export type StepCountersDto = z.infer<typeof stepCountersSchema>;

// What the bucket holds, as of the last maintenance run; null until the first one (docs/09 §9.5).
export const storageUsageSchema = z.object({
  objects: z.number().int().nonnegative(),
  bytes: z.string(),
  measuredAt: z.string().datetime(),
});
export type StorageUsageDto = z.infer<typeof storageUsageSchema>;

export const queueOverviewResponseSchema = z.object({
  queues: z.array(queueDepthSchema),
  documents: z.object({
    total: z.number().int().nonnegative(),
    steps: z.array(stepCountersSchema),
  }),
  storage: storageUsageSchema.nullable(),
});
export type QueueOverviewResponse = z.infer<typeof queueOverviewResponseSchema>;

export const failedJobDtoSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  // Whatever the job carried; the UI shows a summary and links what it recognizes.
  payload: z.unknown(),
  error: z.string(),
  failedAt: z.string().datetime(),
  retryCount: z.number().int().nonnegative(),
});
export type FailedJobDto = z.infer<typeof failedJobDtoSchema>;

export const listQueueFailuresResponseSchema = z.object({
  items: z.array(failedJobDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ListQueueFailuresResponse = z.infer<typeof listQueueFailuresResponseSchema>;

export const retryJobResponseSchema = z.object({ ok: z.literal(true) });
export type RetryJobResponse = z.infer<typeof retryJobResponseSchema>;

// How hard the instance works (docs/11 §11.13). Two different knobs:
//
// - `concurrency` — how many jobs of one queue run at once. This is throughput across documents.
// - `unitConcurrency` — how many independent units inside a single job run at once: the pages of a
//   scan set being cropped, say. This is throughput inside one piece of work, and it is one number
//   because the units are all the same shape of work — reading and resizing an image.
//
// Both are bounded: the point of a queue is that an instance under load stays usable, and a box
// that lets somebody type 500 is a box that lets somebody take the machine down.
export const QUEUE_CONCURRENCY_MAX = 32;

export const queueSettingsSchema = z.object({
  concurrency: z.record(z.string(), z.number().int().min(1).max(QUEUE_CONCURRENCY_MAX)),
  unitConcurrency: z.number().int().min(1).max(QUEUE_CONCURRENCY_MAX),
});
export type QueueSettingsDto = z.infer<typeof queueSettingsSchema>;

// Sent whole: the form shows every knob at once, so it saves every knob at once.
export const updateQueueSettingsRequestSchema = queueSettingsSchema;
export type UpdateQueueSettingsRequest = z.infer<typeof updateQueueSettingsRequestSchema>;
