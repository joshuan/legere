import { describe, expect, it } from 'vitest';
import { loadConfig } from './app-config';

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig({
      APP_BASE_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      AUTH_SECRET: 'x'.repeat(32),
    });

    expect(config.get('PORT')).toBe(3000);
    expect(config.get('S3_BUCKET')).toBe('legere');
    expect(config.get('S3_FORCE_PATH_STYLE')).toBe(true);
    expect(config.get('SMTP_SECURE')).toBe(false);
    expect(config.isProduction).toBe(false);
  });

  it('remembers which keys the environment carried, so a default can be told from an override', () => {
    const config = loadConfig({
      APP_BASE_URL: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
      AUTH_SECRET: 'x'.repeat(32),
      PORT: '4000',
      // Present but empty: the app sees the schema's default, and so must this (docs/07 §7.3).
      SMTP_HOST: '',
    });

    expect(config.isFromEnv('PORT')).toBe(true);
    expect(config.isFromEnv('SMTP_HOST')).toBe(false);
    expect(config.isFromEnv('LOG_LEVEL')).toBe(false);
  });

  it('throws a readable error when required vars are missing or invalid', () => {
    expect(() => loadConfig({ APP_BASE_URL: 'not-a-url', AUTH_SECRET: 'too-short' })).toThrowError(
      /Invalid environment configuration/,
    );
  });
});
