import { describe, expect, it } from 'vitest';
import { configWarnings, loadConfig } from './app-config';

// The minimum an environment must carry: the three the schema has always required, plus the two S3
// credentials that lost their defaults when production stopped being allowed to run on published
// example values (docs/12 §12.4a).
const MINIMAL = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
  AUTH_SECRET: 'x'.repeat(32),
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config.get('PORT')).toBe(3000);
    expect(config.get('S3_BUCKET')).toBe('legere');
    expect(config.get('S3_FORCE_PATH_STYLE')).toBe(true);
    expect(config.get('SMTP_SECURE')).toBe(false);
    expect(config.isProduction).toBe(false);
  });

  it('remembers which keys the environment carried, so a default can be told from an override', () => {
    const config = loadConfig({
      ...MINIMAL,
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

  it('has no S3 credentials of its own to fall back on', () => {
    const { S3_ACCESS_KEY_ID: _id, S3_SECRET_ACCESS_KEY: _secret, ...withoutS3 } = MINIMAL;

    expect(() => loadConfig(withoutS3)).toThrowError(/S3_ACCESS_KEY_ID/);
  });

  describe('in production', () => {
    const PRODUCTION = {
      ...MINIMAL,
      NODE_ENV: 'production',
      APP_BASE_URL: 'https://legere.example',
      // A mail server, because a production instance without one refuses to start (see below).
      SMTP_HOST: 'smtp.legere.example',
    };

    it('refuses the example AUTH_SECRET published in this repository', () => {
      expect(() =>
        loadConfig({ ...PRODUCTION, AUTH_SECRET: 'dev-secret-change-me-min-32-chars!!' }),
      ).toThrowError(/Refusing to start in production[\s\S]*AUTH_SECRET/);
    });

    it('refuses the example S3 secret published in this repository', () => {
      expect(() =>
        loadConfig({ ...PRODUCTION, S3_SECRET_ACCESS_KEY: 'legere-secret' }),
      ).toThrowError(/Refusing to start in production[\s\S]*S3_SECRET_ACCESS_KEY/);
    });

    it('names every refusal at once, so an operator fixes three things in one pass', () => {
      expect(() =>
        loadConfig({
          ...PRODUCTION,
          AUTH_SECRET: 'dev-secret-change-me-min-32-chars!!',
          S3_SECRET_ACCESS_KEY: 'legere-secret',
        }),
      ).toThrowError(/AUTH_SECRET[\s\S]*S3_SECRET_ACCESS_KEY/);
    });

    // 🔒 A PDF runs script in the origin that served it, and the viewer embeds one from a presigned
    // URL. Sharing an origin with the bucket turns any document in the archive into app-origin XSS.
    it('refuses to serve the bucket from its own origin', () => {
      expect(() =>
        loadConfig({
          ...PRODUCTION,
          S3_PUBLIC_ENDPOINT: 'https://legere.example/s3',
        }),
      ).toThrowError(/same origin/);
    });

    it('accepts the bucket on an origin of its own', () => {
      const config = loadConfig({
        ...PRODUCTION,
        S3_PUBLIC_ENDPOINT: 'https://files.legere.example',
      });

      expect(config.isProduction).toBe(true);
    });

    it('falls back to S3_ENDPOINT when no public endpoint is configured, and checks that instead', () => {
      expect(() =>
        loadConfig({
          ...PRODUCTION,
          S3_ENDPOINT: 'https://legere.example',
          S3_PUBLIC_ENDPOINT: '',
        }),
      ).toThrowError(/same origin/);
    });

    // 🔒 SEC-18: the shipped deployment is the unconfigured one, and the code that used to be
    // readable in its log is not written anywhere now — so an instance with no mail server is one
    // nobody can sign up to, and it says so at boot instead of at the sign-up form.
    it('refuses an empty SMTP_HOST, because the code has nowhere to go and is never logged', () => {
      const { SMTP_HOST: _smtp, ...withoutSmtp } = PRODUCTION;

      expect(() => loadConfig(withoutSmtp)).toThrowError(
        /Refusing to start in production[\s\S]*SMTP_HOST is empty/,
      );
      expect(() => loadConfig({ ...withoutSmtp, SMTP_HOST: '' })).toThrowError(
        /SMTP_HOST is empty/,
      );
    });

    it('runs without mail when the operator asks for it in writing', () => {
      const { SMTP_HOST: _smtp, ...withoutSmtp } = PRODUCTION;

      const config = loadConfig({ ...withoutSmtp, ALLOW_UNCONFIGURED_EMAIL: 'true' });

      expect(config.get('SMTP_HOST')).toBe('');
      expect(configWarnings(config).join('\n')).toMatch(/SMTP_HOST is empty/);
    });

    it('lets development run on exactly what production refuses', () => {
      const config = loadConfig({
        ...MINIMAL,
        AUTH_SECRET: 'dev-secret-change-me-min-32-chars!!',
        S3_SECRET_ACCESS_KEY: 'legere-secret',
      });

      expect(config.isProduction).toBe(false);
    });
  });
});

describe('configWarnings', () => {
  it('says what plain HTTP costs', () => {
    const warnings = configWarnings(loadConfig({ ...MINIMAL }));

    expect(warnings.join('\n')).toMatch(/Secure/);
  });

  it('says nothing about the scheme when the instance is served over TLS', () => {
    const warnings = configWarnings(
      loadConfig({ ...MINIMAL, APP_BASE_URL: 'https://legere.example' }),
    );

    expect(warnings.join('\n')).not.toMatch(/Secure/);
  });

  it('says that an instance without a mail server can create no account at all', () => {
    const warnings = configWarnings(loadConfig({ ...MINIMAL }));

    expect(warnings.join('\n')).toMatch(/SMTP_HOST is empty/);

    const configured = configWarnings(loadConfig({ ...MINIMAL, SMTP_HOST: 'smtp.example.com' }));
    expect(configured.join('\n')).not.toMatch(/SMTP_HOST/);
  });

  it('warns in development about the value production will refuse', () => {
    const warnings = configWarnings(
      loadConfig({ ...MINIMAL, AUTH_SECRET: 'dev-secret-change-me-min-32-chars!!' }),
    );

    expect(warnings.join('\n')).toMatch(/AUTH_SECRET/);
  });
});
