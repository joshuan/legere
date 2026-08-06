import { configSchema, type ConfigValues } from './config.schema';

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
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const config = new AppConfig(result.data, providedKeys(env));
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

  // 🔒 The document viewer embeds the canonical PDF from a presigned URL, and a PDF viewer runs
  // script in the origin that served it. That is harmless only while the bucket is a *different*
  // origin from the app: put them on one, and any document in the archive can script the app
  // (docs/09 §9.2, security audit SEC-39). The invariant is silent, so it is asserted here.
  const bucketOrigin = browserFacingOrigin(config);
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

  if (!config.isProduction) {
    for (const { key, value } of PUBLISHED_EXAMPLES) {
      if (config.get(key) === value) {
        warnings.push(`${key} is the published example value; production will refuse to start on it`);
      }
    }
  }

  return warnings;
}

// The origin a browser is sent to for a presigned URL: the public endpoint when one is configured,
// the server's own otherwise (docs/09 §9.2).
function browserFacingOrigin(config: AppConfig): string | null {
  const configured = config.get('S3_PUBLIC_ENDPOINT');
  return originOf(configured === '' ? config.get('S3_ENDPOINT') : configured);
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
