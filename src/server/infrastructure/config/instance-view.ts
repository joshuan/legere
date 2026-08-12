import type {
  Consequence,
  InstanceResponse,
  InstanceSettingDto,
  SettingSource,
} from '../../../shared/contracts/instance';
import type { AppConfig } from './app-config';
import type { ConfigValues } from './config.schema';

// What this server resolved its configuration to, grouped the way docs/12 §12.4 groups it and
// answering the questions an operator asks at 2 a.m.: which database is this, where does OCR go,
// which model is answering, is mail configured at all (docs/07 §7.3, docs/11 §11.13a).
//
// What a blank costs is named, not written out: a `Consequence` token travels and the client says
// it in the operator's language. This file decides which outcome a blank has; it does not decide
// what an outcome sounds like in Russian.

// 🔒 The deny-list. A key named here never travels as a value: its row says SET or UNSET and
// nothing else, whatever the environment holds. It is written out once, here, rather than decided
// at each call site, so that adding a credential to the schema is a decision made in the open and
// forgetting to redact one is visible in a diff.
//
// The Turnstile site key is on it deliberately. It is public by design — it is baked into the
// client bundle — but it is still a key, and what an operator needs from this page is "a CAPTCHA is
// configured", which SET says in full.
export const SECRET_KEYS: ReadonlySet<keyof ConfigValues> = new Set([
  'AUTH_SECRET',
  'TURNSTILE_SECRET_KEY',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'SMTP_PASSWORD',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'TRANSCRIBER_API_KEY',
  'EMBEDDINGS_API_KEY',
  'CLASSIFIER_API_KEY',
]);

export function describeInstance(config: AppConfig): InstanceResponse {
  // Whether a setting resolved to nothing at all — an empty string, never a zero.
  const blank = (key: keyof ConfigValues): boolean => format(config.get(key)) === null;
  const when = (condition: boolean, consequence: Consequence): Consequence | null =>
    condition ? consequence : null;
  const s = (key: keyof ConfigValues, consequence: Consequence | null = null): InstanceSettingDto =>
    setting(config, key, consequence);

  return {
    groups: [
      {
        key: 'core',
        settings: [s('NODE_ENV'), s('PORT'), s('APP_BASE_URL'), s('LOG_LEVEL')],
      },
      { key: 'database', settings: databaseSettings(config) },
      {
        key: 'storage',
        settings: [
          s('S3_ENDPOINT'),
          s(
            'S3_PUBLIC_ENDPOINT',
            when(blank('S3_PUBLIC_ENDPOINT'), 'SIGNED_URLS_USE_INTERNAL_ENDPOINT'),
          ),
          s('S3_REGION'),
          s('S3_BUCKET'),
          s('S3_ACCESS_KEY_ID'),
          s('S3_SECRET_ACCESS_KEY'),
          s('S3_FORCE_PATH_STYLE'),
          s('SIGNED_URL_TTL_SEC'),
        ],
      },
      {
        key: 'library',
        settings: [
          s('LIBRARY_ROOT'),
          s('GROUPING_WINDOW_MINUTES'),
          s('SCAN_MAX_FILES', when(config.get('SCAN_MAX_FILES') === 0, 'SCAN_UNLIMITED')),
          s('UPLOAD_MAX_BYTES'),
        ],
      },
      {
        key: 'processing',
        settings: [
          s('STIRLING_URL'),
          s('DOCLING_URL', when(blank('DOCLING_URL'), 'MARKDOWN_FALLS_BACK_TO_STIRLING')),
          s('DOCLING_PICTURE_DESCRIPTION'),
          s('OCR_LANGUAGES'),
          s('PDF_TEXT_MIN_CHARS_PER_PAGE'),
          s('IMAGE_PAGE_CORRECTION'),
          s('PREVIEW_MAX_DIM'),
          s('THUMB_MAX_DIM'),
          s('CHUNK_TARGET_CHARS'),
          s('CHUNK_OVERLAP_CHARS'),
          s('ANALYST_EXCERPT_CHARS'),
          s('ANALYST_MAX_PAGE_IMAGES'),
          s('ANALYST_AUTO_MAX_PAGES'),
          s('TRANSCRIBER_API_BASE_URL'),
          s('TRANSCRIBER_API_KEY'),
          s('TRANSCRIBER_MODEL'),
          s('TRANSCRIBER_MAX_PAGES'),
          s('TRANSCRIBER_PAGE_IMAGE_MAX_DIM'),
          s('ANALYST_PAGE_IMAGE_MAX_DIM'),
        ],
      },
      {
        key: 'ai',
        settings: [
          s(
            'EMBEDDINGS_API_BASE_URL',
            when(blank('EMBEDDINGS_API_BASE_URL'), 'VECTORIZATION_SKIPPED_NO_PROVIDER'),
          ),
          s('EMBEDDINGS_API_KEY'),
          s('EMBEDDINGS_MODEL', when(blank('EMBEDDINGS_MODEL'), 'VECTORIZATION_SKIPPED_NO_MODEL')),
          s('EMBEDDING_DIMENSIONS'),
          // An empty classifier URL is not a blank on its own: the analysis falls back to the
          // embeddings provider, and only when that is empty too does the step stop running.
          s(
            'CLASSIFIER_API_BASE_URL',
            when(
              blank('CLASSIFIER_API_BASE_URL'),
              blank('EMBEDDINGS_API_BASE_URL')
                ? 'ANALYSIS_SKIPPED_NO_PROVIDER'
                : 'ANALYSIS_USES_EMBEDDINGS_PROVIDER',
            ),
          ),
          s('CLASSIFIER_API_KEY'),
          s('CLASSIFIER_MODEL', when(blank('CLASSIFIER_MODEL'), 'ANALYSIS_SKIPPED_NO_MODEL')),
        ],
      },
      {
        key: 'email',
        settings: [
          s('SMTP_HOST', when(blank('SMTP_HOST'), 'EMAIL_UNDELIVERABLE')),
          s('SMTP_PORT'),
          s('SMTP_SECURE'),
          s('SMTP_USER'),
          s('SMTP_PASSWORD'),
          s('SMTP_FROM'),
        ],
      },
      {
        key: 'auth',
        settings: [
          s('AUTH_SECRET'),
          s('SESSION_TTL_DAYS'),
          s('API_TOKEN_TTL_DAYS'),
          s('COOKIE_DOMAIN', when(blank('COOKIE_DOMAIN'), 'COOKIE_NOT_SHARED_WITH_SUBDOMAINS')),
          s('TURNSTILE_SECRET_KEY', 'CAPTCHA_DISABLED'),
          s('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'CAPTCHA_WIDGET_ABSENT'),
        ],
      },
      {
        key: 'queue',
        settings: [
          s('QUEUE_CONCURRENCY_INGEST'),
          s('QUEUE_CONCURRENCY_PROCESS'),
          s('QUEUE_UNIT_CONCURRENCY'),
          s('QUEUE_REPROCESS_MAX'),
        ],
      },
    ],
  };
}

// One row. A secret answers only whether there is one; everything else carries what it resolved to,
// with where that came from. A consequence describes a blank, so it is dropped once the blank is
// filled — including for a secret, where "configured" is all the page may say.
function setting(
  config: AppConfig,
  key: keyof ConfigValues,
  consequence: Consequence | null,
): InstanceSettingDto {
  const value = format(config.get(key));

  if (SECRET_KEYS.has(key)) {
    const configured = value !== null;
    return {
      key,
      value: null,
      source: configured ? 'SET' : 'UNSET',
      consequence: configured ? null : consequence,
    };
  }

  return { key, value, source: config.isFromEnv(key) ? 'ENV' : 'DEFAULT', consequence };
}

// 🔒 DATABASE_URL never appears whole — it carries the password. What an operator actually asks of
// it is four things, and none of them is the credential (docs/07 §7.3).
function databaseSettings(config: AppConfig): InstanceSettingDto[] {
  const parts = parseDatabaseUrl(config.get('DATABASE_URL'));
  const source: SettingSource = config.isFromEnv('DATABASE_URL') ? 'ENV' : 'DEFAULT';
  return [
    { key: 'DATABASE_HOST', value: parts.host, source, consequence: null },
    { key: 'DATABASE_PORT', value: parts.port, source, consequence: null },
    { key: 'DATABASE_NAME', value: parts.database, source, consequence: null },
    { key: 'DATABASE_USER', value: parts.user, source, consequence: null },
  ];
}

type DatabaseParts = {
  host: string | null;
  port: string | null;
  database: string | null;
  user: string | null;
};

function parseDatabaseUrl(url: string): DatabaseParts {
  try {
    const parsed = new URL(url);
    // `parsed.password` is read here and nowhere else — that is, not at all.
    return {
      host: emptyToNull(parsed.hostname),
      port: emptyToNull(parsed.port),
      database: emptyToNull(decodeURIComponent(parsed.pathname.replace(/^\//, ''))),
      user: emptyToNull(decodeURIComponent(parsed.username)),
    };
  } catch {
    // A connection string nothing can parse is reported as four blanks rather than by falling back
    // to the string itself: that string is precisely what must not be shown.
    return { host: null, port: null, database: null, user: null };
  }
}

// Everything travels as a string. An empty one is not a value at all: it reads as "Not set", which
// is the honest answer for `SMTP_HOST=` and for an SMTP_HOST nobody wrote.
function format(value: string | number | boolean): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return emptyToNull(String(value));
}

function emptyToNull(value: string): string | null {
  return value === '' ? null : value;
}
