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
  // 🔒 Whether to believe `X-Forwarded-For`, and how far (docs/12 §12.8). Empty — the default —
  // means no: the header is a thing the client writes, so trusting it without an ingress that
  // rewrites it hands every caller a fresh rate-limit bucket per request. A number is a hop count;
  // anything else is passed to Express as it stands, so `loopback` and CIDR lists work.
  TRUST_PROXY: z.string().default(''),

  // database
  DATABASE_URL: z.string().min(1),

  // auth
  AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // The default lifetime of a read-only API token; the owner may pick anything up to a year
  // (docs/08 §8.2a).
  API_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(90),
  COOKIE_DOMAIN: z.string().default(''),
  TURNSTILE_SECRET_KEY: z.string().default(''),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().default(''),

  // email (empty SMTP_HOST → LogEmailSender, which delivers nothing)
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: envBoolean(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default('Legere <no-reply@example.com>'),
  // 🔒 Permission to run an instance that cannot send mail (docs/12 §12.4a). Every account is
  // created, verified and recovered through a six-digit code that arrives by email and is written
  // nowhere else — not to the log, which is where it used to go — so an empty SMTP_HOST in
  // production is an instance nobody can sign up to, and production refuses to start on it. Setting
  // this says that is wanted: an archive whose accounts already exist, or a mail server being fixed.
  ALLOW_UNCONFIGURED_EMAIL: envBoolean(false),

  // library volume
  LIBRARY_ROOT: z.string().min(1).default('/library'),
  // How close in time two scans must sit to be read as one sitting at the scanner, and therefore
  // suggested as one document (docs/05 §5.6a). Nothing is grouped automatically; this only decides
  // what is offered.
  GROUPING_WINDOW_MINUTES: z.coerce.number().int().positive().default(10),
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
  // No defaults, deliberately: a credential that works without being set is a credential published
  // in this repository (docs/12 §12.4a). Every path that runs the app supplies them — `.env` in
  // development, the compose file in a deployment, the test setup in CI.
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBoolean(true),
  SIGNED_URL_TTL_SEC: z.coerce.number().int().positive().default(300),

  // Stirling-PDF
  STIRLING_URL: z.string().url().default('http://localhost:8080'),

  // Docling: layout-aware parsing (docs/05 §5.5). Empty = the pipeline falls back to Stirling's own
  // converter, which reads text but flattens structure.
  DOCLING_URL: z.string().default(''),
  // Captions for the pictures inside a document, written by a local vision model. Off by default,
  // and deliberately: measured on one 1-page ticket with three pictures it took 17 minutes at ~4
  // cores, and the caption of a railway logo read "a flag, red and white" — it never named the
  // operator. Needs a Docling image built with PICTURE_DESCRIPTION_MODEL set (docs/12 §12.4).
  DOCLING_PICTURE_DESCRIPTION: envBoolean(false),

  // processing
  // Tesseract codes for the first OCR pass, before a document's own languages are known. Written
  // the way tesseract takes them on the command line (docs/03 §3.3.10).
  OCR_LANGUAGES: z.string().default('rus+eng'),
  PDF_TEXT_MIN_CHARS_PER_PAGE: z.coerce.number().int().nonnegative().default(32),
  PREVIEW_MAX_DIM: z.coerce.number().int().positive().default(1600),
  THUMB_MAX_DIM: z.coerce.number().int().positive().default(400),
  CHUNK_TARGET_CHARS: z.coerce.number().int().positive().default(1000),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(200),
  // How much of a document the analyst is shown. 0 — the default — is all of it: a cap left a model
  // naming a contract from its letterhead (docs/05 §5.5 step 4).
  ANALYST_EXCERPT_CHARS: z.coerce.number().int().nonnegative().default(0),
  // And how many of its pages travel as pictures beside that text.
  ANALYST_MAX_PAGE_IMAGES: z.coerce.number().int().nonnegative().default(20),
  ANALYST_PAGE_IMAGE_MAX_DIM: z.coerce.number().int().positive().default(1200),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_PROCESS: z.coerce.number().int().positive().default(2),
  // How many independent units inside one job run at once — the pages of a scan set being cropped,
  // say. The default is 1 because it was the behaviour before the knob existed (docs/05 §5.4).
  QUEUE_UNIT_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // How many documents one "run this step again" may enqueue (docs/07 §7.3). A cap, not a quota:
  // the call is repeatable, so a large archive drains in batches an admin can watch.
  QUEUE_REPROCESS_MAX: z.coerce.number().int().positive().default(500),

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
