import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CryptoSessionTokens } from './crypto-session-tokens';

describe('CryptoSessionTokens', () => {
  const tokens = new CryptoSessionTokens();

  it('generates a base64url token of 32 random bytes with its sha256 hash', () => {
    const { token, hash } = tokens.generate();

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hash).toHaveLength(64);
  });

  it('never repeats a token', () => {
    const generated = new Set(Array.from({ length: 100 }, () => tokens.generate().token));
    expect(generated.size).toBe(100);
  });

  it('hashes deterministically so a presented token can be looked up', () => {
    const { token, hash } = tokens.generate();
    expect(tokens.hash(token)).toBe(hash);
    expect(tokens.hash(`${token}x`)).not.toBe(hash);
  });
});
