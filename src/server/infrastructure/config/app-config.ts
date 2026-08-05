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

// Parse the environment once; on failure throw a readable, multi-line error so the process can fail
// fast at boot with an actionable message (docs/06 §6.6).
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return new AppConfig(result.data, providedKeys(env));
}

// The schema's own keys that the environment carried with something in them.
function providedKeys(env: Record<string, string | undefined>): ReadonlySet<string> {
  return new Set(Object.keys(configSchema.shape).filter((key) => (env[key] ?? '') !== ''));
}
