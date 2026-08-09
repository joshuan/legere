import { describe, expect, it } from 'vitest';
import { escapeLike, folderPrefixPattern } from './like';

// 🔒 A browsed folder is user input and reaches a `LIKE` (docs/05 §5.1).
describe('LIKE patterns', () => {
  it('leaves a folder that holds no metacharacter exactly as it was', () => {
    expect(folderPrefixPattern('invoices/2026')).toBe('invoices/2026/%');
  });

  it('escapes the wildcards, so a folder named with one matches itself and nothing else', () => {
    // Unescaped this is the pattern `%/%`, which is every path in the library.
    expect(folderPrefixPattern('%')).toBe('\\%/%');
    // `_` is a single-character wildcard, quieter and just as wrong.
    expect(folderPrefixPattern('a_b')).toBe('a\\_b/%');
  });

  it('escapes the escape character itself, so it cannot be smuggled in', () => {
    expect(escapeLike('a\\%b')).toBe('a\\\\\\%b');
  });
});
