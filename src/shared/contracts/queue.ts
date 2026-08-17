import { z } from 'zod';
import { paginationQuerySchema } from './common';
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

// POST /api/admin/queue/reprocess — "the previews failed, run them again" (docs/11 §11.13).
// Both halves are optional, and each absence widens the question by one level (docs/11 §11.13):
// step and status — the documents whose named step sits in that status; step alone — that step
// whatever state it is in; neither — the whole pipeline of every document. The cap on one call
// (`QUEUE_REPROCESS_MAX`) is what keeps the widest of those from becoming an indigestible push.
export const reprocessByStepRequestSchema = z.object({
  step: documentStepSchema.optional(),
  status: stepStatusSchema.optional(),
});
export type ReprocessByStepRequest = z.infer<typeof reprocessByStepRequestSchema>;

export const reprocessByStepResponseSchema = z.object({
  enqueued: z.number().int().nonnegative(),
});
export type ReprocessByStepResponse = z.infer<typeof reprocessByStepResponseSchema>;

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

// 🔒 The one list whose cursor is not the opaque base64url string of docs/07 §7.1: this page is read
// out of pg-boss's own tables, which Prisma does not model (docs/04 §4.2), and its cursor is the
// `failedAt` of the last row returned. Said so here, because a cursor nobody validates reaches
// `new Date(cursor)` and the driver answers a 500 for what is plainly a malformed query parameter.
export const listQueueFailuresQuerySchema = paginationQuerySchema.extend({
  cursor: z.string().datetime().optional(),
});
export type ListQueueFailuresQuery = z.infer<typeof listQueueFailuresQuerySchema>;

export const retryJobResponseSchema = z.object({ ok: z.literal(true) });
export type RetryJobResponse = z.infer<typeof retryJobResponseSchema>;

// How hard the instance works (docs/11 §11.13). Two different knobs:
//
// - `concurrency` — how many jobs of one queue run at once. This is throughput across documents.
// - `unitConcurrency` — how many independent units inside a single job run at once: the pages of a
//   files of one document being cropped into pages, say. This is throughput inside one piece of work, and it is one number
//   because the units are all the same shape of work — reading and resizing an image.
//
// Both are bounded: the point of a queue is that an instance under load stays usable, and a box
// that lets somebody type 500 is a box that lets somebody take the machine down.
export const QUEUE_CONCURRENCY_MAX = 32;

// The services an operator may put a gate in front of (docs/05 §5.4b), keyed the way the
// environment names them rather than the way the pipeline names its steps: the thing being throttled
// is whatever `CLASSIFIER_API_BASE_URL` points at, so the gate is `classifier` while the port stays
// a `DocumentAnalyst`. A name this version does not know is dropped on write, exactly as an unknown
// queue name is.
export const SERVICE_NAMES = [
  'stirling',
  'docling',
  'classifier',
  'transcriber',
  'embeddings',
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

// Ten minutes is the longest pause worth offering: past it the job that is waiting has more to fear
// from the hour pg-boss gives it than from the container it is being polite to (docs/06 §6.8).
export const SERVICE_COOLDOWN_MAX_SECONDS = 600;

// One gate, two numbers (docs/05 §5.4b). `concurrency: 0` is not a gate of infinite width — it is no
// gate at all, and with it the cooldown has nothing to hold shut. Both default to `0`, so an
// instance that upgrades into this waits nowhere until somebody says otherwise.
export const serviceGateSchema = z.object({
  concurrency: z.number().int().min(0).max(QUEUE_CONCURRENCY_MAX),
  cooldownSeconds: z.number().int().min(0).max(SERVICE_COOLDOWN_MAX_SECONDS),
});
export type ServiceGateDto = z.infer<typeof serviceGateSchema>;

// Whether the thing at the other end of a gate is there at all (docs/05 §5.4c). Five states rather
// than a boolean, because each names a different repair: a container that is down is not a key that
// is refused is not a service this instance was never given.
export const serviceHealthStatusSchema = z.enum([
  // The probe answered 2xx: nothing to do.
  'UP',
  // 401/403 — the service is there and will not take this instance's credentials. A key, not a host.
  'UNAUTHORIZED',
  // Some other code, carried in `httpStatus`: 404 from a provider that has no `/models` and 502 from
  // a container that is still starting are the same sentence with different repairs, so the number
  // travels instead of a verdict.
  'ANSWERED',
  // Nothing answered — refused, unresolved, or past the timeout.
  'DOWN',
  // 🔒 No base URL to probe. Not a fault: this is what an instance without Docling or without an
  // analyst looks like, and what it costs is said on /admin/instance.
  'NOT_CONFIGURED',
]);
export type ServiceHealthStatus = z.infer<typeof serviceHealthStatusSchema>;

// One service, as the panel reads it: where this instance calls it, and how that call went.
// 🔒 `url` is published with any userinfo stripped, and no API key is in this answer at all.
export const serviceHealthSchema = z.object({
  service: z.enum(SERVICE_NAMES),
  // The base URL this instance resolved — the same string the job log carries as `endpoint`
  // (docs/03 §3.3.18). Empty where nothing is configured.
  url: z.string(),
  status: serviceHealthStatusSchema,
  // The code where there was one; null where nothing answered or nothing was asked.
  httpStatus: z.number().int().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  // When the probe was taken, so an answer served from the cache reads as one.
  checkedAt: z.string().datetime(),
  // A short reason, truncated: the transport's own words for why nothing came back.
  detail: z.string().nullable(),
});
export type ServiceHealthDto = z.infer<typeof serviceHealthSchema>;

export const servicesHealthResponseSchema = z.object({ services: z.array(serviceHealthSchema) });
export type ServicesHealthResponse = z.infer<typeof servicesHealthResponseSchema>;

export const queueSettingsSchema = z.object({
  concurrency: z.record(z.string(), z.number().int().min(1).max(QUEUE_CONCURRENCY_MAX)),
  unitConcurrency: z.number().int().min(1).max(QUEUE_CONCURRENCY_MAX),
  // Queues whose workers are not registered: jobs arrive and wait, nothing consumes them
  // (docs/05 §5.4). The way to stop one misbehaving stage without stopping the instance.
  paused: z.array(z.string()),
  // The same idea one level down (docs/05 §5.4d): steps of the pipeline that no job runs. A queue
  // pause decides whether a worker exists; a step pause decides what a worker does, so this one is
  // read per job and re-registers nothing. A paused step is *held* — left at PENDING with nothing
  // written against it — rather than skipped, because a step that has not run has reached no verdict.
  pausedSteps: z.array(z.string()),
  // How many calls each external service may be doing at once, and how long its slot stays shut
  // afterwards. It travels beside the queue knobs because it is the same kind of setting — how hard
  // this instance works — and it lives in the same settings row (docs/05 §5.4b, docs/07 §7.3).
  services: z.record(z.string(), serviceGateSchema),
});
export type QueueSettingsDto = z.infer<typeof queueSettingsSchema>;

// Sent whole: the form shows every knob at once, so it saves every knob at once.
export const updateQueueSettingsRequestSchema = queueSettingsSchema;
export type UpdateQueueSettingsRequest = z.infer<typeof updateQueueSettingsRequestSchema>;

// GET /api/pipeline/paused-steps — the one fact about the queue that is not an admin's alone
// (docs/05 §5.4d, docs/11 §11.5). A step reading `PENDING` for ever is either waiting for a worker or
// paused, and whoever opened the document is owed the difference; nothing else about the queue is
// published here, and a paused step is not a secret — it is visible on every document it holds.
export const pausedStepsResponseSchema = z.object({ pausedSteps: z.array(documentStepSchema) });
export type PausedStepsResponse = z.infer<typeof pausedStepsResponseSchema>;
