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
