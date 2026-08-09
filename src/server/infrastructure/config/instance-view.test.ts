import { describe, expect, it } from 'vitest';
import { CONSEQUENCES, instanceResponseSchema } from '../../../shared/contracts/instance';
import { loadConfig } from './app-config';
import { configSchema } from './config.schema';
import { SECRET_KEYS, describeInstance } from './instance-view';

const AUTH_SECRET = 'auth-secret-nobody-may-ever-see-1234';
const SMTP_PASSWORD = 'smtp-password-nobody-may-ever-see';
const DATABASE_PASSWORD = 'database-password-nobody-may-ever-see';

const S3_SECRET = 's3-secret-nobody-may-ever-see';

const MINIMAL = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: `postgresql://legere:${DATABASE_PASSWORD}@db.internal:5433/archive?schema=public`,
  AUTH_SECRET,
  S3_ACCESS_KEY_ID: 's3-access-key-nobody-may-ever-see',
  S3_SECRET_ACCESS_KEY: S3_SECRET,
};

const view = (env: Record<string, string> = {}) =>
  describeInstance(loadConfig({ ...MINIMAL, ...env }));

const rowsOf = (env: Record<string, string> = {}) =>
  view(env).groups.flatMap((group) => group.settings);

const rowFor = (key: string, env: Record<string, string> = {}) => {
  const row = rowsOf(env).find((setting) => setting.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row;
};

describe('describeInstance', () => {
  it('answers the contract, grouped the way docs/12 §12.4 groups it', () => {
    const parsed = instanceResponseSchema.parse(view());

    expect(parsed.groups.map((group) => group.key)).toEqual([
      'core',
      'database',
      'storage',
      'library',
      'processing',
      'ai',
      'email',
      'auth',
      'queue',
    ]);
    // Every group carries rows: an empty card on the page would say nothing.
    expect(parsed.groups.every((group) => group.settings.length > 0)).toBe(true);
    // No key is reported twice, here or across groups.
    const keys = parsed.groups.flatMap((group) => group.settings.map((setting) => setting.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe('🔒 a secret is never a value', () => {
    it('keeps configured secrets out of the response entirely', () => {
      const serialized = JSON.stringify(
        view({
          SMTP_HOST: 'smtp.example.com',
          SMTP_PASSWORD,
          S3_ACCESS_KEY_ID: 's3-access-key-id-nobody-may-see',
          S3_SECRET_ACCESS_KEY: 's3-secret-nobody-may-see',
          EMBEDDINGS_API_KEY: 'sk-embeddings-nobody-may-see',
          CLASSIFIER_API_KEY: 'sk-classifier-nobody-may-see',
          TURNSTILE_SECRET_KEY: 'turnstile-secret-nobody-may-see',
          NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'turnstile-site-key',
        }),
      );

      for (const secret of [
        AUTH_SECRET,
        SMTP_PASSWORD,
        DATABASE_PASSWORD,
        's3-access-key-id-nobody-may-see',
        's3-secret-nobody-may-see',
        'sk-embeddings-nobody-may-see',
        'sk-classifier-nobody-may-see',
        'turnstile-secret-nobody-may-see',
        'turnstile-site-key',
      ]) {
        expect(serialized).not.toContain(secret);
      }
    });

    it('says SET for a configured secret and UNSET for one nobody set', () => {
      expect(rowFor('AUTH_SECRET')).toEqual({
        key: 'AUTH_SECRET',
        value: null,
        source: 'SET',
        consequence: null,
      });

      const smtp = rowFor('SMTP_PASSWORD', { SMTP_PASSWORD });
      expect(smtp).toMatchObject({ value: null, source: 'SET' });
      // Nothing configured it, and the schema's default is empty.
      expect(rowFor('SMTP_PASSWORD')).toMatchObject({ value: null, source: 'UNSET' });
    });

    it('never lets a secret ride along inside another row', () => {
      // DATABASE_URL is the trap: the password sits in the middle of the string an operator most
      // wants to see. It is decomposed instead, and the whole string is never a row.
      expect(rowsOf().some((setting) => setting.key === 'DATABASE_URL')).toBe(false);
      expect(rowFor('DATABASE_HOST')).toMatchObject({ value: 'db.internal', source: 'ENV' });
      expect(rowFor('DATABASE_PORT').value).toBe('5433');
      expect(rowFor('DATABASE_NAME').value).toBe('archive');
      expect(rowFor('DATABASE_USER').value).toBe('legere');
    });

    it('reports four blanks rather than the string when the URL cannot be parsed', () => {
      const rows = rowsOf({ DATABASE_URL: `nonsense-${DATABASE_PASSWORD}` });
      const database = rows.filter((setting) => setting.key.startsWith('DATABASE_'));

      expect(database).toHaveLength(4);
      expect(database.every((setting) => setting.value === null)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(DATABASE_PASSWORD);
    });
  });

  describe('where a value came from', () => {
    it('is ENV when the environment set it and DEFAULT when nothing did', () => {
      expect(rowFor('PORT')).toMatchObject({ value: '3000', source: 'DEFAULT' });
      expect(rowFor('PORT', { PORT: '4000' })).toMatchObject({ value: '4000', source: 'ENV' });
      expect(rowFor('OCR_LANGUAGES')).toMatchObject({ value: 'rus+eng', source: 'DEFAULT' });
      expect(rowFor('OCR_LANGUAGES', { OCR_LANGUAGES: 'deu' })).toMatchObject({
        value: 'deu',
        source: 'ENV',
      });
    });

    it('reads an empty environment variable as the default it resolves to', () => {
      // `SMTP_HOST=` in a .env file and no SMTP_HOST at all mean the same thing to the app, so they
      // must read the same here.
      expect(rowFor('SMTP_HOST', { SMTP_HOST: '' })).toMatchObject({
        value: null,
        source: 'DEFAULT',
      });
    });

    it('renders booleans and empty strings the way the page reads them', () => {
      expect(rowFor('S3_FORCE_PATH_STYLE').value).toBe('true');
      expect(rowFor('SMTP_SECURE').value).toBe('false');
      expect(rowFor('COOKIE_DOMAIN').value).toBeNull();
      // Zero is a value, not a blank: it is how the scan guard is switched off.
      expect(rowFor('SCAN_MAX_FILES', { SCAN_MAX_FILES: '0' }).value).toBe('0');
    });
  });

  describe('what a blank costs', () => {
    // A token, never a sentence: the page is localized, and prose from here would arrive in English
    // beside a Russian label (docs/07 §7.3).
    it('travels as a token the client localizes, not as English prose', () => {
      const consequences = rowsOf()
        .map((setting) => setting.consequence)
        .filter((consequence) => consequence !== null);

      expect(consequences.length).toBeGreaterThan(0);
      for (const consequence of consequences) {
        expect(CONSEQUENCES).toContain(consequence);
        expect(consequence).toMatch(/^[A-Z][A-Z_]*$/);
      }
    });

    it('says mail is unconfigured in terms of what happens to the codes', () => {
      expect(rowFor('SMTP_HOST').consequence).toBe('EMAIL_UNDELIVERABLE');
      expect(rowFor('SMTP_HOST', { SMTP_HOST: 'smtp.example.com' }).consequence).toBeNull();
    });

    it('names the steps that stop running without a provider', () => {
      expect(rowFor('EMBEDDINGS_API_BASE_URL').consequence).toBe(
        'VECTORIZATION_SKIPPED_NO_PROVIDER',
      );
      // The embeddings model has a default, so only an emptied one leaves nothing to ask.
      expect(rowFor('EMBEDDINGS_MODEL').consequence).toBeNull();
      expect(rowFor('EMBEDDINGS_MODEL', { EMBEDDINGS_MODEL: '' }).consequence).toBe(
        'VECTORIZATION_SKIPPED_NO_MODEL',
      );
      expect(rowFor('CLASSIFIER_API_BASE_URL').consequence).toBe('ANALYSIS_SKIPPED_NO_PROVIDER');
      expect(rowFor('CLASSIFIER_MODEL').consequence).toBe('ANALYSIS_SKIPPED_NO_MODEL');
      // With embeddings configured the analysis borrows that provider rather than stopping.
      expect(
        rowFor('CLASSIFIER_API_BASE_URL', {
          EMBEDDINGS_API_BASE_URL: 'https://api.openai.com/v1',
        }).consequence,
      ).toBe('ANALYSIS_USES_EMBEDDINGS_PROVIDER');
      expect(
        rowFor('EMBEDDINGS_API_BASE_URL', { EMBEDDINGS_API_BASE_URL: 'https://api.openai.com/v1' })
          .consequence,
      ).toBeNull();
    });

    it('carries a consequence for a secret nobody set, and drops it once it is set', () => {
      expect(rowFor('TURNSTILE_SECRET_KEY').consequence).toBe('CAPTCHA_DISABLED');
      expect(rowFor('NEXT_PUBLIC_TURNSTILE_SITE_KEY').consequence).toBe('CAPTCHA_WIDGET_ABSENT');
      expect(
        rowFor('TURNSTILE_SECRET_KEY', { TURNSTILE_SECRET_KEY: 'a-key' }).consequence,
      ).toBeNull();
    });

    it('is silent where a blank costs nothing', () => {
      expect(rowFor('NODE_ENV').consequence).toBeNull();
      expect(rowFor('S3_BUCKET').consequence).toBeNull();
      expect(rowFor('SMTP_PASSWORD').consequence).toBeNull();
      expect(rowFor('QUEUE_CONCURRENCY_INGEST').consequence).toBeNull();
    });

    it('explains the fallbacks the pipeline takes quietly', () => {
      expect(rowFor('DOCLING_URL').consequence).toBe('MARKDOWN_FALLS_BACK_TO_STIRLING');
      expect(rowFor('DOCLING_URL', { DOCLING_URL: 'http://docling:5001' }).consequence).toBeNull();
      expect(rowFor('S3_PUBLIC_ENDPOINT').consequence).toBe('SIGNED_URLS_USE_INTERNAL_ENDPOINT');
      expect(rowFor('COOKIE_DOMAIN').consequence).toBe('COOKIE_NOT_SHARED_WITH_SUBDOMAINS');
      expect(rowFor('SCAN_MAX_FILES', { SCAN_MAX_FILES: '0' }).consequence).toBe('SCAN_UNLIMITED');
      expect(rowFor('SCAN_MAX_FILES').consequence).toBeNull();
    });
  });

  // 🔒 The redaction list is a deny-list: a key it does not name travels as its value. That is the
  // right shape for a page whose job is to show configuration, and the wrong shape for the day
  // somebody adds a credential to the schema and to a group and to nothing else. This is the
  // backstop — it fails in CI rather than in an admin's screenshot.
  describe('the redaction list keeps up with the schema', () => {
    // Keys whose name reads like a credential and is not one. Each is here by decision, not by
    // oversight: a lifetime in days tells an attacker nothing.
    const NOT_SECRETS: ReadonlySet<string> = new Set(['API_TOKEN_TTL_DAYS']);

    it('names every key in the schema that looks like a credential', () => {
      const credentialShaped = Object.keys(configSchema.shape).filter(
        (key) => /SECRET|PASSWORD|KEY|TOKEN/.test(key) && !NOT_SECRETS.has(key),
      );

      const unredacted = credentialShaped.filter((key) => !hasSecretKey(key));

      expect(unredacted).toEqual([]);
    });

    it('holds nothing the schema no longer has', () => {
      const schemaKeys = new Set(Object.keys(configSchema.shape));

      expect([...SECRET_KEYS].filter((key) => !schemaKeys.has(key))).toEqual([]);
    });
  });
});

// `SECRET_KEYS` is typed by the schema's keys; the schema's keys arrive from `Object.keys` as
// strings. Asking the set about a string is the whole point of the test, and this is how it is done
// without a type assertion.
function hasSecretKey(key: string): boolean {
  return [...SECRET_KEYS].some((secret) => secret === key);
}
