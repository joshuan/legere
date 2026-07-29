import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from './argon2-password-hasher';

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('produces a PHC string with the OWASP parameters of docs/08 §8.1.5', async () => {
    const hash = await hasher.hash('a-decent-passphrase');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
  });

  it('round-trips: verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('a-decent-passphrase');
    expect(await hasher.verify(hash, 'a-decent-passphrase')).toBe(true);
    expect(await hasher.verify(hash, 'a-decent-passphras')).toBe(false);
  });

  it('salts each hash, so the same password hashes differently', async () => {
    const [first, second] = await Promise.all([hasher.hash('same'), hasher.hash('same')]);
    expect(first).not.toBe(second);
    expect(await hasher.verify(first, 'same')).toBe(true);
    expect(await hasher.verify(second, 'same')).toBe(true);
  });

  it('returns false instead of throwing on a malformed hash', async () => {
    expect(await hasher.verify('not-a-phc-string', 'whatever')).toBe(false);
    expect(await hasher.verify('', 'whatever')).toBe(false);
  });
});
