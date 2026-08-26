import { configSchema, RENAMED_KEYS, type ConfigValues } from './config.schema';

// Typed, validated configuration exposed to DI (docs/06 §6.6). Injected via its class token;
// `process.env` is read nowhere else in the codebase.
export class AppConfig {
  constructor(
    private readonly values: ConfigValues,
    // Which of the schema's keys the environment actually carried, remembered at parse time because
    // it is the only moment anything sees the raw environment. `/admin/instance` needs it to tell a
    // value somebody set from a default nobody overrode (docs/07 §7.3).
    private readonly fromEnv: ReadonlySet<string> = new Set(),
  ) {}

  get<K extends keyof ConfigValues>(key: K): ConfigValues[K] {
    return this.values[key];
  }

  // Did the environment set this key, or is what we hold the schema's default? An empty value counts
  // as unset: `SMTP_HOST=` in a .env file and no SMTP_HOST at all mean the same thing to the app.
  isFromEnv(key: keyof ConfigValues): boolean {
    return this.fromEnv.has(key);
  }

  get isProduction(): boolean {
    return this.values.NODE_ENV === 'production';
  }

  // Whether the app is served over TLS, read from the address it is served under (docs/08 §8.2).
  // The `Secure` cookie attribute follows this and not NODE_ENV: a browser silently drops a Secure
  // cookie over plain HTTP, so a self-hosted instance on `http://192.168.x.x` could never keep a
  // session — while an HTTPS deployment gets the attribute whatever NODE_ENV says.
  get usesHttps(): boolean {
    return this.values.APP_BASE_URL.startsWith('https://');
  }

  // The origin a browser is sent to for a presigned URL: the public endpoint when one is configured,
  // the server's own otherwise (docs/09 §9.2). `null` when neither parses as a URL — only reachable
  // through `S3_PUBLIC_ENDPOINT`, which is a free-form string because it may be empty.
  //
  // Two things read it, and both need the same answer: the boot refusal below, which will not let
  // the bucket share an origin with the app (SEC-39), and the page CSP, which has to name the host a
  // preview or a canonical PDF redirects to (docs/12 §12.8a).
  get bucketOrigin(): string | null {
    const configured = this.values.S3_PUBLIC_ENDPOINT;
    return originOf(configured === '' ? this.values.S3_ENDPOINT : configured);
  }
}

// The values this repository publishes as examples. They exist so a reader can copy a file and see
// the app start; a production instance running on one of them is running on a credential anybody can
// read on GitHub, which is why §12.4a refuses them rather than warning about them.
const PUBLISHED_EXAMPLES: ReadonlyArray<{
  readonly key: 'AUTH_SECRET' | 'S3_SECRET_ACCESS_KEY';
  readonly value: string;
}> = [
  { key: 'AUTH_SECRET', value: 'dev-secret-change-me-min-32-chars!!' },
  { key: 'S3_SECRET_ACCESS_KEY', value: 'legere-secret' },
];

// Parse the environment once; on failure throw a readable, multi-line error so the process can fail
// fast at boot with an actionable message (docs/06 §6.6). A production instance is then held to
// more than the schema's shape (docs/12 §12.4a) — the same collected-error format, because an
// operator fixing three things wants to be told three things once.
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // What a key used to be called is read before the schema sees anything, so the rest of the
  // process only ever knows the name a key has now (docs/12 §12.4).
  const resolved = withRenamedKeys(env);
  const result = configSchema.safeParse(resolved);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // Over the resolved environment, not the raw one: a value inherited from a pre-rename name was
  // still set by an operator, and `/admin/instance` must not report it as a default nobody chose.
  const config = new AppConfig(result.data, providedKeys(resolved));
  const refusals = productionRefusals(config);
  if (refusals.length > 0) {
    throw new Error(
      `Refusing to start in production:\n${refusals.map((line) => `  - ${line}`).join('\n')}`,
    );
  }
  return config;
}

// What a production instance may not run on. Empty in development and test, where the published
// examples are the point: `npm run dev` on a fresh clone has to work.
function productionRefusals(config: AppConfig): readonly string[] {
  if (!config.isProduction) return [];

  const refusals: string[] = [];

  for (const { key, value } of PUBLISHED_EXAMPLES) {
    if (config.get(key) === value) {
      refusals.push(`${key} is the example value published in this repository — generate your own`);
    }
  }

  // 🔒 An instance with no mail server cannot create an account: the six-digit code of every
  // registration, verification and reset (docs/08 §8.1.3) arrives by email and is written nowhere
  // else — the log fallback records that a letter was not sent and never what was in it. That used
  // to be the shipped default, which made "can read the container log" mean "can take over any
  // account". Refusing it here is what keeps the demo path from being reached by accident on a real
  // instance; an operator who wants it says so (docs/12 §12.4a, security audit SEC-18).
  if (config.get('SMTP_HOST') === '' && !config.get('ALLOW_UNCONFIGURED_EMAIL')) {
    refusals.push(
      'SMTP_HOST is empty — nobody can sign up, verify an address or finish a password reset, because the code is emailed and never logged; configure SMTP, or set ALLOW_UNCONFIGURED_EMAIL=true to run without mail deliberately',
    );
  }

  // 🔒 The document viewer embeds the canonical PDF from a presigned URL, and a PDF viewer runs
  // script in the origin that served it. That is harmless only while the bucket is a *different*
  // origin from the app: put them on one, and any document in the archive can script the app
  // (docs/09 §9.2, security audit SEC-39). The invariant is silent, so it is asserted here.
  const bucketOrigin = config.bucketOrigin;
  if (bucketOrigin !== null && bucketOrigin === originOf(config.get('APP_BASE_URL'))) {
    refusals.push(
      'the bucket browsers reach and APP_BASE_URL are the same origin — a document served from it could script the app',
    );
  }

  return refusals;
}

// What the app is running on that is not wrong, but costs something the operator should know about.
// Kept out of `loadConfig` because it needs a logger, and configuration is parsed before there is
// one (docs/06 §6.7).
export function configWarnings(config: AppConfig): readonly string[] {
  const warnings: string[] = [];

  if (!config.usesHttps) {
    warnings.push(
      'APP_BASE_URL is not https — session cookies travel without the Secure attribute, and so does everything else',
    );
  }

  // On a laptop this is the surprise worth having at boot rather than at the sign-up form; in
  // production it can only be reached deliberately (ALLOW_UNCONFIGURED_EMAIL), and repeating it at
  // every start is how an operator notices the deliberate thing has outlived its reason.
  if (config.get('SMTP_HOST') === '') {
    warnings.push(
      'SMTP_HOST is empty — a letter is recorded as its recipient and subject, delivered to nobody, and the code inside it is written nowhere at all; registration, verification and password resets cannot complete until a mail server is configured (docs/12 §12.5)',
    );
  }

  if (!config.isProduction) {
    for (const { key, value } of PUBLISHED_EXAMPLES) {
      if (config.get(key) === value) {
        warnings.push(
          `${key} is the published example value; production will refuse to start on it`,
        );
      }
    }
  }

  return warnings;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// The schema's own keys that the environment carried with something in them.
function providedKeys(env: Record<string, string | undefined>): ReadonlySet<string> {
  return new Set(Object.keys(configSchema.shape).filter((key) => (env[key] ?? '') !== ''));
}

// The current name wins wherever it is set; where it is not, the name the key used to carry is read
// in its place (`RENAMED_KEYS`, docs/12 §12.4). An upgrade must not turn a cap somebody set into the
// default, and an operator who has moved to the new name must not be second-guessed by an old one
// still sitting in the same environment.
function withRenamedKeys(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const resolved = { ...env };
  for (const { now, before } of RENAMED_KEYS) {
    if ((resolved[now] ?? '') === '' && (env[before] ?? '') !== '') resolved[now] = env[before];
  }
  return resolved;
}
