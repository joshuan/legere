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
  // How long a file of ours waits in the trash before the hourly sweep deletes it (docs/05 §5.7a).
  // The one scheduled destruction in Legere, and it only ever reaches objects in our own bucket: an
  // original on a library volume is not ours to delete however this is set, and waits for a person.
  TRASH_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

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
  // Whether an image is corrected on its way into the canonical: the lighting levelled, the skew
  // taken out (docs/05 §5.5 step 1). On, because it is what makes a photographed page readable at
  // all — and it costs an archive of flat scans nothing, since a page that is already even and
  // straight is passed through untouched rather than re-encoded. Off is for an operator who would
  // rather have every page exactly as the camera left it.
  IMAGE_PAGE_CORRECTION: envBoolean(true),
  PREVIEW_MAX_DIM: z.coerce.number().int().positive().default(1600),
  THUMB_MAX_DIM: z.coerce.number().int().positive().default(400),
  CHUNK_TARGET_CHARS: z.coerce.number().int().positive().default(1000),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().nonnegative().default(200),
  // The knobs of the service `CLASSIFIER_API_BASE_URL` turns on, named after it rather than after
  // the port that calls it (docs/12 §12.4): a setting that tunes a service belongs in the same
  // namespace as the one that switched it on, which is the rule the per-service gates below follow
  // too. The pre-rename `ANALYST_*` names are still read where the new one is absent — see
  // `RENAMED_KEYS`.
  //
  // How much of a document the analyst is shown. 0 — the default — is all of it: a cap left a model
  // naming a contract from its letterhead (docs/05 §5.5 step 4).
  CLASSIFIER_EXCERPT_CHARS: z.coerce.number().int().nonnegative().default(0),
  // And how many of its pages travel as pictures beside that text.
  CLASSIFIER_MAX_PAGE_IMAGES: z.coerce.number().int().nonnegative().default(20),
  // How long a document the pipeline analyses without being asked. Past this it does not analyse a
  // shortened version — it does not analyse at all, and says so: a verdict read off the first ten
  // pages of a forty-page contract is worse than no verdict, because it looks like one. A person may
  // still ask for the whole document from its own page (docs/05 §5.5 step 4). 0 = no limit.
  CLASSIFIER_AUTO_MAX_PAGES: z.coerce.number().int().nonnegative().default(10),
  // The recogniser of last resort (docs/05 §5.5 step 3): a vision model reading the pages of a
  // document that had to be recognised at all. Empty leaves the tesseract result standing, which is
  // how this product behaved before it existed. Separate from the analyst's own settings, because an
  // instance may want a different model for reading a page than for judging one — or one and not the
  // other.
  TRANSCRIBER_API_BASE_URL: z.string().default(''),
  TRANSCRIBER_API_KEY: z.string().default(''),
  TRANSCRIBER_MODEL: z.string().default(''),
  // How many pages of one document it may read. Transcribing forty pages is a different decision
  // from analysing them, so it is a different number.
  TRANSCRIBER_MAX_PAGES: z.coerce.number().int().nonnegative().default(20),
  TRANSCRIBER_PAGE_IMAGE_MAX_DIM: z.coerce.number().int().positive().default(1600),
  CLASSIFIER_PAGE_IMAGE_MAX_DIM: z.coerce.number().int().positive().default(1200),
  QUEUE_CONCURRENCY_INGEST: z.coerce.number().int().positive().default(4),
  QUEUE_CONCURRENCY_PROCESS: z.coerce.number().int().positive().default(2),
  // How many independent units inside one job run at once — the pages of a scan set being cropped,
  // say. The default is 1 because it was the behaviour before the knob existed (docs/05 §5.4).
  QUEUE_UNIT_CONCURRENCY: z.coerce.number().int().positive().default(1),
  // How many documents one "run this step again" may enqueue (docs/07 §7.3). A cap, not a quota:
  // the call is repeatable, so a large archive drains in batches an admin can watch.
  QUEUE_REPROCESS_MAX: z.coerce.number().int().positive().default(500),

  // Per-service gates (docs/05 §5.4b): how many units of one service's work may be in flight, and
  // how long a finished unit's slot stays shut afterwards. Named after the service an operator
  // configures rather than after the step that calls it — the thing being throttled is whatever
  // `CLASSIFIER_API_BASE_URL` points at. Both default to 0 for every service, which is no gate at
  // all: an instance that upgrades into this behaves exactly as it behaved. A stored setting
  // overrides these, the way a queue concurrency does (docs/03 §3.3.21).
  SERVICE_CONCURRENCY_STIRLING: z.coerce.number().int().nonnegative().default(0),
  SERVICE_COOLDOWN_STIRLING: z.coerce.number().int().nonnegative().default(0),
  SERVICE_CONCURRENCY_DOCLING: z.coerce.number().int().nonnegative().default(0),
  SERVICE_COOLDOWN_DOCLING: z.coerce.number().int().nonnegative().default(0),
  SERVICE_CONCURRENCY_CLASSIFIER: z.coerce.number().int().nonnegative().default(0),
  SERVICE_COOLDOWN_CLASSIFIER: z.coerce.number().int().nonnegative().default(0),
  SERVICE_CONCURRENCY_TRANSCRIBER: z.coerce.number().int().nonnegative().default(0),
  SERVICE_COOLDOWN_TRANSCRIBER: z.coerce.number().int().nonnegative().default(0),
  SERVICE_CONCURRENCY_EMBEDDINGS: z.coerce.number().int().nonnegative().default(0),
  SERVICE_COOLDOWN_EMBEDDINGS: z.coerce.number().int().nonnegative().default(0),

  // AI providers (empty base URL = feature disabled)
  EMBEDDINGS_API_BASE_URL: z.string().default(''),
  EMBEDDINGS_API_KEY: z.string().default(''),
  // A local model by default (docs/12 §12.4): ollama serves bge-m3 on the OpenAI-compatible path
  // this client speaks, it is multilingual, and 1024 is the width the column is sized for.
  EMBEDDINGS_MODEL: z.string().default('bge-m3'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),
  CLASSIFIER_API_BASE_URL: z.string().default(''),
  CLASSIFIER_API_KEY: z.string().default(''),
  CLASSIFIER_MODEL: z.string().default(''),
});

export type ConfigValues = z.infer<typeof configSchema>;

// 🔒 What a key used to be called, still read where the current name is absent (docs/12 §12.4). An
// environment is not a database anybody migrates: it lives in a compose file, a systemd unit or a
// shell profile on somebody else's machine, and a rename that stopped reading the old name would
// silently hand a running instance the default instead — `ANALYST_AUTO_MAX_PAGES=10` becoming "no
// cap at all" is a rename that costs money on the next long document. The old name is read, never
// written: `/admin/instance` reports the row under the name it has now.
export const RENAMED_KEYS: ReadonlyArray<{
  readonly now: keyof ConfigValues;
  readonly before: string;
}> = [
  { now: 'CLASSIFIER_EXCERPT_CHARS', before: 'ANALYST_EXCERPT_CHARS' },
  { now: 'CLASSIFIER_MAX_PAGE_IMAGES', before: 'ANALYST_MAX_PAGE_IMAGES' },
  { now: 'CLASSIFIER_AUTO_MAX_PAGES', before: 'ANALYST_AUTO_MAX_PAGES' },
  { now: 'CLASSIFIER_PAGE_IMAGE_MAX_DIM', before: 'ANALYST_PAGE_IMAGE_MAX_DIM' },
];
