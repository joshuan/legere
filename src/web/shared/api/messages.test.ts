import { describe, expect, it } from 'vitest';
import en from '../../../../messages/en.json';
import ru from '../../../../messages/ru.json';
import { ERROR_CODES } from '../../../shared/contracts/common';
import { ERROR_MESSAGE_KEYS } from './error-messages';

// Walks a catalog into dotted keys so both files can be compared key-for-key.
function flatten(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    flatten(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

describe('message catalogs', () => {
  it('ru mirrors the reference catalog en exactly (ADR-016)', () => {
    expect(flatten(ru).sort()).toEqual(flatten(en).sort());
  });

  it('resolves a message for every error code in both locales', () => {
    const enKeys = new Set(flatten(en));
    const ruKeys = new Set(flatten(ru));

    for (const code of ERROR_CODES) {
      const key = ERROR_MESSAGE_KEYS[code];
      expect(enKeys.has(key), `missing en message for ${code}`).toBe(true);
      expect(ruKeys.has(key), `missing ru message for ${code}`).toBe(true);
    }
    expect(enKeys.has(ERROR_MESSAGE_KEYS.NETWORK)).toBe(true);
  });
});
