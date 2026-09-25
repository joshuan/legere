import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDatabaseUrl, validateTestDatabaseUrls } from './database-url';

afterEach(() => vi.unstubAllEnvs());

describe('destructive integration database guard', () => {
  it.each([
    undefined,
    '',
    'not a URL',
    'postgresql://user:secret@localhost/legere',
    'postgresql://user:secret@localhost/legere_test/production',
    'postgresql://user:secret@localhost/legere%5Ftest',
    'https://user:secret@localhost/legere_test',
  ])('rejects an unsafe database URL without printing credentials: %s', (value) => {
    expect(() => testDatabaseUrl(value, 'DATABASE_URL')).toThrow(/dedicated/);
    try {
      testDatabaseUrl(value, 'DATABASE_URL');
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });

  it('allows separate roles on the same dedicated database', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://app:secret@localhost/legere_test');
    vi.stubEnv('MIGRATION_DATABASE_URL', 'postgresql://owner:secret@localhost:5432/legere_test');
    expect(validateTestDatabaseUrls).not.toThrow();
  });

  it.each([
    'postgresql://owner:secret@localhost/legere',
    'postgresql://owner:secret@localhost/other_test',
    'postgresql://owner:secret@other-host/legere_test',
    'postgresql://owner:secret@localhost:5433/legere_test',
  ])('rejects cleanup against a different database: %s', (migration) => {
    vi.stubEnv('DATABASE_URL', 'postgresql://app:secret@localhost/legere_test');
    vi.stubEnv('MIGRATION_DATABASE_URL', migration);
    expect(validateTestDatabaseUrls).toThrow();
  });

  it('uses the runtime URL when no separate migration credential is configured', () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://app:secret@localhost/legere_test');
    vi.stubEnv('MIGRATION_DATABASE_URL', undefined);
    expect(validateTestDatabaseUrls).not.toThrow();
  });
});
