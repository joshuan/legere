import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config/app-config';
import { HmacVerificationCodes } from './hmac-verification-codes';

// The six-digit code of docs/08 §8.1.3 is the credential that creates every account on this
// instance, and the row it is checked against is one an operator can read. 🔒 §8.6: the code is
// stored as an HMAC under `AUTH_SECRET`, never as itself, and compared in constant time.

const SECRET = 'a-test-secret-of-at-least-32-characters';

const config = loadConfig({
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
  AUTH_SECRET: SECRET,
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
});

describe('HmacVerificationCodes', () => {
  const codes = new HmacVerificationCodes(config);

  it('generates exactly six digits, keeping the leading zeros a person would type', () => {
    const generated = Array.from({ length: 200 }, () => codes.generate());

    for (const code of generated) expect(code).toMatch(/^\d{6}$/);
    // Six digits give a million values; 200 draws that all agreed would not be random.
    expect(new Set(generated).size).toBeGreaterThan(150);
  });

  it('stores an HMAC under AUTH_SECRET rather than the code itself', () => {
    const hash = codes.hash('123456');

    expect(hash).toBe(createHmac('sha256', SECRET).update('123456').digest('hex'));
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain('123456');
  });

  // 🔒 Without the secret the digest is unsalted SHA-256 of one of a million values — a table
  // anybody can build. With it, reading the row buys nothing.
  it('is not reproducible by somebody who has the row but not the secret', () => {
    const other = new HmacVerificationCodes(
      loadConfig({
        APP_BASE_URL: 'http://localhost:3000',
        DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
        AUTH_SECRET: 'a-different-secret-of-32-characters!!',
        S3_ACCESS_KEY_ID: 'access-key',
        S3_SECRET_ACCESS_KEY: 'secret-key',
      }),
    );

    expect(other.hash('123456')).not.toBe(codes.hash('123456'));
  });

  it('accepts the code it hashed and refuses every other one', () => {
    const hash = codes.hash('000042');

    expect(codes.matches(hash, '000042')).toBe(true);
    expect(codes.matches(hash, '000043')).toBe(false);
    expect(codes.matches(hash, '42')).toBe(false);
    expect(codes.matches(hash, '')).toBe(false);
  });

  // `timingSafeEqual` throws on a length mismatch, which would turn a malformed row into a 500 and
  // an oracle at the same time; the comparison answers false instead.
  it('answers false rather than throwing on a hash that is not one of ours', () => {
    expect(codes.matches('not-hex', '123456')).toBe(false);
    expect(codes.matches('', '123456')).toBe(false);
    expect(codes.matches('ab'.repeat(8), '123456')).toBe(false);
  });
});
