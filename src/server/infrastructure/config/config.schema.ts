import { z } from 'zod';

// Boolean env vars arrive as strings; z.coerce.boolean() treats "false" as true, so parse explicitly.
const envBoolean = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

// The full environment contract (docs/12 §12.4), validated once at boot (docs/06 §6.6).
// Only DATABASE_URL, APP_BASE_URL and AUTH_SECRET are strictly required; everything else has a
// sensible default (dev/compose values) so the process starts with minimal configuration.
export const configSchema = z.object({
  // core
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().url(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // database
  DATABASE_URL: z.string().min(1),

  // auth
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_DOMAIN: z.string().default(''),
  TURNSTILE_SECRET_KEY: z.string().default(''),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().default(''),

  // email (empty SMTP_HOST → LogEmailSender)
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: envBoolean(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('Legere <no-reply@example.com>'),

  // library volume
  LIBRARY_ROOT: z.string().min(1).default('/library'),
  // A scan that walks into the wrong tree — a home directory, a whole disk — will happily ingest all
  // of it. This is the stop (docs/05 §5.2): the scan gives up past this many files and says so in
  // the journal instead of spending the night hashing. 0 disables the guard.
  SCAN_MAX_FILES: z.coerce.number().int().nonnegative().default(50_000),
  // The largest file a user may send from the browser (docs/05 §5.1a). Read while the body streams
  // in, so an oversized upload is refused rather than buffered.
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(100 * 1024 * 1024),

  // S3 (derived artifacts)
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  // The endpoint browsers use, when it differs from the one the server uses — a bundled MinIO is
  // reachable as `http://minio:9000` inside the compose network and as `http://localhost:9000` from
  // the outside, and a presigned URL is only valid for the host it was signed against (docs/09 §9.2).
  // Empty = the two are the same.
  S3_PUBLIC_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('legere'),
  S3_ACCESS_KEY_ID: z.string().min(1).default('legere'),
  S3_SECRET_ACCESS_KEY: z.string().min(1).default('legere-secret'),
  S3_FORCE_PATH_STYLE: envBoolean(true),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(300),

  // Stirling-PDF
  STIRLING_URL: z.string().url().default('http://localhost:8080'),

  // processing
  OCR_LANGUAGES: z.string().default('rus+eng'),
  PDF_TEXT_MIN_CHARS_PER_PAGE: z.coerce.number().int().nonnegative().default(32),
  PREVIEW_MAX_DIM: z.coerce.number().int().positive().default(1600),
  THUMB_MAX_DIM: z.coerce.number().int().positive().default(400),
  CHUNK_TARGET_CHARS: z.coerce.number().int().positive().default(1000),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(200),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_PROCESS: z.coerce.number().int().positive().default(2),

  // AI providers (empty base URL = feature disabled)
  EMBEDDINGS_API_BASE_URL: z.string().default(''),
  EMBEDDINGS_API_KEY: z.string().default(''),
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  CLASSIFIER_API_BASE_URL: z.string().default(''),
  CLASSIFIER_API_KEY: z.string().default(''),
  CLASSIFIER_MODEL: z.string().default(''),
});

export type ConfigValues = z.infer<typeof configSchema>;
