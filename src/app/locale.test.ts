import { describe, expect, it } from 'vitest';
import { pickLocale } from '../i18n/locale';

describe('locale negotiation', () => {
  it('prioritizes a supported cookie and otherwise uses language quality', () => {
    expect(pickLocale('ru', 'en;q=1')).toBe('ru');
    expect(pickLocale('invalid', 'en;q=0.4, ru-RU;q=0.9')).toBe('ru');
  });

  it.each([
    ['ru;q=0,en;q=0.5', 'en'],
    ['english,ru;q=0.5', 'ru'],
    ['rubbish,en;q=0.5', 'en'],
    ['ru;q=2,en;q=0.5', 'en'],
    ['ru;q=NaN,en;q=0.5', 'en'],
    ['RU-ru; q=0.9,en;q=0.5', 'ru'],
    ['fr-CA,en-US;q=0.8,ru;q=0.1', 'en'],
  ])('resolves %s to %s', (header, expected) => {
    expect(pickLocale(undefined, header)).toBe(expected);
  });

  it('falls back to English for an absent or unsupported header', () => {
    expect(pickLocale(undefined, null)).toBe('en');
    expect(pickLocale(undefined, 'fr')).toBe('en');
  });
});
