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

  // A key that has been renamed is still read under the name it had (docs/12 §12.4): an environment
  // lives in somebody's compose file, and a rename nobody could see would hand a running instance
  // the default in place of the cap it had set.
  describe('a key that was renamed', () => {
    it('takes the current name where it is set', () => {
      const config = loadConfig({
        ...MINIMAL,
        CLASSIFIER_AUTO_MAX_PAGES: '40',
        ANALYST_AUTO_MAX_PAGES: '10',
      });

      expect(config.get('CLASSIFIER_AUTO_MAX_PAGES')).toBe(40);
    });

    it('reads the name it used to have where the current one is absent', () => {
      const config = loadConfig({
        ...MINIMAL,
        ANALYST_EXCERPT_CHARS: '4000',
        ANALYST_MAX_PAGE_IMAGES: '5',
        ANALYST_AUTO_MAX_PAGES: '25',
        ANALYST_PAGE_IMAGE_MAX_DIM: '900',
      });

      expect(config.get('CLASSIFIER_EXCERPT_CHARS')).toBe(4000);
      expect(config.get('CLASSIFIER_MAX_PAGE_IMAGES')).toBe(5);
      expect(config.get('CLASSIFIER_AUTO_MAX_PAGES')).toBe(25);
      expect(config.get('CLASSIFIER_PAGE_IMAGE_MAX_DIM')).toBe(900);
      // Inherited from an operator's own setting, so the instance page must not report it as a
      // default nobody chose (docs/11 §11.13a).
      expect(config.isFromEnv('CLASSIFIER_AUTO_MAX_PAGES')).toBe(true);
    });

    it('falls back to the schema default when neither name is set', () => {
      const config = loadConfig({ ...MINIMAL });

      expect(config.get('CLASSIFIER_AUTO_MAX_PAGES')).toBe(10);
      expect(config.get('CLASSIFIER_EXCERPT_CHARS')).toBe(0);
      expect(config.isFromEnv('CLASSIFIER_AUTO_MAX_PAGES')).toBe(false);
    });

    it('treats an empty current name as absent rather than as an override', () => {
      // `CLASSIFIER_AUTO_MAX_PAGES=` in a .env file is not a value, which is the rule every other
      // key follows here.
      const config = loadConfig({
        ...MINIMAL,
        CLASSIFIER_AUTO_MAX_PAGES: '',
        ANALYST_AUTO_MAX_PAGES: '25',
      });

      expect(config.get('CLASSIFIER_AUTO_MAX_PAGES')).toBe(25);
    });
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

  // 🔒 SEC-77. The CAPTCHA is two switches in two places and only one of them is an environment
  // variable at runtime: setting the secret turns verification on for every login, registration and
  // password reset, and the token those requests must carry is minted by a widget that exists only
  // if the *client bundle* was built with the site key. Get that pair wrong and nobody signs in —
  // the last administrator included — with nothing anywhere that says why.
  describe('the CAPTCHA', () => {
    it('says what a secret key with no widget in front of it does, whenever one is set', () => {
      const warnings = configWarnings(
        loadConfig({ ...MINIMAL, TURNSTILE_SECRET_KEY: 'a-real-turnstile-secret' }),
      );

      expect(warnings.join('\n')).toMatch(/TURNSTILE_SECRET_KEY is set/);
      // Naming the build argument is the actionable half: no runtime value can supply it.
      expect(warnings.join('\n')).toMatch(/NEXT_PUBLIC_TURNSTILE_SITE_KEY/);
      expect(warnings.join('\n')).toMatch(
        /nobody can sign in, register or finish a password reset/,
      );
    });

    // 🔒 Unconditional on purpose. `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in the runtime environment does
    // nothing at all — Next inlines it at build time — so an operator who copies both keys into
    // `.env`, which is the natural thing to do, must not thereby buy silence. This is the case the
    // `/admin/instance` row cannot cover, and the reason this is a warning and not a refusal.
    it('says it again when the site key is in the runtime environment, where it does nothing', () => {
      const warnings = configWarnings(
        loadConfig({
          ...MINIMAL,
          TURNSTILE_SECRET_KEY: 'a-real-turnstile-secret',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
        }),
      );

      expect(warnings.join('\n')).toMatch(/TURNSTILE_SECRET_KEY is set/);
    });

    it('says nothing at all on the shipped default, where there is no CAPTCHA to get wrong', () => {
      const warnings = configWarnings(loadConfig({ ...MINIMAL }));

      expect(warnings.join('\n')).not.toMatch(/TURNSTILE/);
    });

    // A refusal was the other candidate and it would have been wrong: an image built correctly from
    // this repository carries the site key in its bundle and not in its environment, so a boot check
    // on the runtime value refuses exactly the instance that did it right (docs/12 §12.4a).
    it('does not refuse a production instance over it', () => {
      const config = loadConfig({
        ...MINIMAL,
        NODE_ENV: 'production',
        APP_BASE_URL: 'https://legere.example',
        SMTP_HOST: 'smtp.legere.example',
        TURNSTILE_SECRET_KEY: 'a-real-turnstile-secret',
      });

      expect(config.isProduction).toBe(true);
      expect(configWarnings(config).join('\n')).toMatch(/TURNSTILE_SECRET_KEY is set/);
    });
  });

  it('warns in development about the value production will refuse', () => {
    const warnings = configWarnings(
      loadConfig({ ...MINIMAL, AUTH_SECRET: 'dev-secret-change-me-min-32-chars!!' }),
    );

    expect(warnings.join('\n')).toMatch(/AUTH_SECRET/);
  });
});
