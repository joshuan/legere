import { describe, expect, it } from 'vitest';
import { instanceResponseSchema } from '../../../shared/contracts/instance';
import { loadConfig } from './app-config';
import { describeInstance } from './instance-view';

const AUTH_SECRET = 'auth-secret-nobody-may-ever-see-1234';
const SMTP_PASSWORD = 'smtp-password-nobody-may-ever-see';
const DATABASE_PASSWORD = 'database-password-nobody-may-ever-see';

const MINIMAL = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: `postgresql://legere:${DATABASE_PASSWORD}@db.internal:5433/archive?schema=public`,
  AUTH_SECRET,
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
    it('says mail is unconfigured in terms of what happens to the codes', () => {
      expect(rowFor('SMTP_HOST').consequence).toMatch(/log/);
      expect(rowFor('SMTP_HOST', { SMTP_HOST: 'smtp.example.com' }).consequence).toBeNull();
    });

    it('names the steps that stop running without a provider', () => {
      expect(rowFor('EMBEDDINGS_API_BASE_URL').consequence).toMatch(/vectorization is skipped/i);
      expect(rowFor('CLASSIFIER_API_BASE_URL').consequence).toMatch(/skipped/i);
      // With embeddings configured the analysis borrows that provider rather than stopping.
      expect(
        rowFor('CLASSIFIER_API_BASE_URL', {
          EMBEDDINGS_API_BASE_URL: 'https://api.openai.com/v1',
        }).consequence,
      ).toMatch(/embeddings provider/i);
      expect(
        rowFor('EMBEDDINGS_API_BASE_URL', { EMBEDDINGS_API_BASE_URL: 'https://api.openai.com/v1' })
          .consequence,
      ).toBeNull();
    });

    it('carries a consequence for a secret nobody set, and drops it once it is set', () => {
      expect(rowFor('TURNSTILE_SECRET_KEY').consequence).toMatch(/CAPTCHA is disabled/);
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
      expect(rowFor('DOCLING_URL').consequence).toMatch(/Stirling/);
      expect(rowFor('DOCLING_URL', { DOCLING_URL: 'http://docling:5001' }).consequence).toBeNull();
      expect(rowFor('S3_PUBLIC_ENDPOINT').consequence).toMatch(/S3_ENDPOINT/);
      expect(rowFor('SCAN_MAX_FILES', { SCAN_MAX_FILES: '0' }).consequence).toMatch(/No limit/);
      expect(rowFor('SCAN_MAX_FILES').consequence).toBeNull();
    });
  });
});
