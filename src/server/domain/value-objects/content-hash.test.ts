import { describe, expect, it } from 'vitest';
import { ContentHash, ContentHashError } from './content-hash';

const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// The identity of a document's content (docs/06 §6.2). Deduplication is content equality (ADR-009),
// so one canonical form is the whole point: the same bytes must key the same document no matter how
// the hash was written down.
describe('ContentHash', () => {
  it('accepts a lower-case sha256 hex digest', () => {
    expect(ContentHash.parse(SHA256).value).toBe(SHA256);
  });

  it('canonicalizes case and surrounding whitespace', () => {
    expect(ContentHash.parse(`  ${SHA256.toUpperCase()}\n`).value).toBe(SHA256);
    // 🔒 Two spellings of one digest must not become two documents.
    expect(ContentHash.parse(SHA256.toUpperCase()).equals(ContentHash.parse(SHA256))).toBe(true);
  });

  it('rejects anything that is not a sha256 digest', () => {
    for (const raw of [
      '',
      'not-a-hash',
      SHA256.slice(0, 63), // one short
      `${SHA256}0`, // one long
      SHA256.replace('e', 'g'), // not hex
      `${SHA256.slice(0, 32)} ${SHA256.slice(33)}`, // a space in the middle, not at the edges
      'e3b0c442-98fc-1c14-9afb-f4c8996fb924', // a UUID is the wrong kind of identifier entirely
    ]) {
      expect(() => ContentHash.parse(raw)).toThrow(ContentHashError);
    }
  });

  it('offers a non-throwing parse for input that came from outside', () => {
    expect(ContentHash.tryParse(SHA256)?.value).toBe(SHA256);
    expect(ContentHash.tryParse('nope')).toBeNull();
  });

  it('compares by value, not by identity', () => {
    const one = ContentHash.parse(SHA256);
    const other = ContentHash.parse(SHA256);
    const different = ContentHash.parse('a'.repeat(64));

    expect(one).not.toBe(other);
    expect(one.equals(other)).toBe(true);
    expect(one.equals(different)).toBe(false);
  });

  it('prints as the digest itself, so it can be logged without unwrapping', () => {
    expect(ContentHash.parse(SHA256).toString()).toBe(SHA256);
    expect(String(ContentHash.parse(SHA256))).toBe(SHA256);
  });
});
