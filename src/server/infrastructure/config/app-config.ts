import { configSchema, type ConfigValues } from './config.schema';

// Typed, validated configuration exposed to DI (docs/06 §6.6). Injected via its class token;
// `process.env` is read nowhere else in the codebase.
export class AppConfig {
  constructor(private readonly values: ConfigValues) {}

  get<K extends keyof ConfigValues>(key: K): ConfigValues[K] {
    return this.values[key];
  }

  get isProduction(): boolean {
    return this.values.NODE_ENV === 'production';
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
  return new AppConfig(result.data);
}
