import { z } from 'zod';

export const OCR_PROVIDERS = ['google-document-ai', 'yandex-vision'] as const;
export const ocrProviderSchema = z.enum(OCR_PROVIDERS);
export type OcrProviderId = z.infer<typeof ocrProviderSchema>;
export const yandexOcrModelSchema = z.enum(['page', 'table', 'handwritten']);
export const ocrStatusSchema = z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
export type OcrStatus = z.infer<typeof ocrStatusSchema>;

export const startOcrSchema = z
  .object({
    requestId: z.string().uuid(),
    pageIds: z.array(z.string().uuid()).min(1).max(2000).optional(),
    providers: z.array(ocrProviderSchema).min(1).max(2),
    yandexModel: yandexOcrModelSchema.default('page'),
    force: z.boolean().default(false),
  })
  .strict();
export type StartOcrRequest = z.input<typeof startOcrSchema>;
export type StartOcrInput = z.infer<typeof startOcrSchema>;

export const ocrPointSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type OcrPoint = z.infer<typeof ocrPointSchema>;
export const ocrElementSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  level: z.enum(['block', 'line', 'word']),
  order: z.number().int().nonnegative(),
  text: z.string(),
  polygon: z.array(ocrPointSchema).min(3),
  confidence: z.number().min(0).max(1).nullable(),
});
export type OcrElement = z.infer<typeof ocrElementSchema>;
export const ocrResultSchema = z.object({
  schemaVersion: z.literal(1),
  pageId: z.string().uuid(),
  imageHash: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  provider: ocrProviderSchema,
  model: z.string(),
  fullText: z.string(),
  elements: z.array(ocrElementSchema),
});
export type OcrResult = z.infer<typeof ocrResultSchema>;

export const ocrPageDtoSchema = z.object({
  id: z.string().uuid(),
  pageId: z.string().uuid(),
  pageNumber: z.number().int().positive(),
  provider: ocrProviderSchema,
  model: z.string(),
  status: ocrStatusSchema,
  attempts: z.number().int().nonnegative(),
  submittedAttempts: z.number().int().nonnegative(),
  cached: z.boolean(),
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  hasImage: z.boolean(),
  hasRaw: z.boolean(),
  completedAt: z.string().datetime().nullable(),
});
export type OcrPageDto = z.infer<typeof ocrPageDtoSchema>;
export const ocrRunDtoSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  stale: z.boolean(),
  pages: z.array(ocrPageDtoSchema),
});
export type OcrRunDto = z.infer<typeof ocrRunDtoSchema>;
export const ocrProviderDtoSchema = z.object({
  id: ocrProviderSchema,
  configured: z.boolean(),
  model: z.string(),
});
export type OcrProviderDto = z.infer<typeof ocrProviderDtoSchema>;
export const ocrRunsResponseSchema = z.object({
  pages: z.array(z.object({ id: z.string().uuid(), number: z.number().int().positive() })),
  providers: z.array(ocrProviderDtoSchema),
  runs: z.array(ocrRunDtoSchema),
});
export type OcrRunsResponse = z.infer<typeof ocrRunsResponseSchema>;
