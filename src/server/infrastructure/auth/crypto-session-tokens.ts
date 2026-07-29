import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SessionTokens, type GeneratedToken } from '../../application/ports/session-tokens';

// docs/08 §8.2: token = randomBytes(32).base64url; the DB stores sha256(token).
// Plain sha256 (not a password KDF) is correct here — the token already has 256 bits of entropy,
// so brute-forcing the hash is infeasible and lookups stay fast.
const TOKEN_BYTES = 32;

@Injectable()
export class CryptoSessionTokens extends SessionTokens {
  generate(): GeneratedToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: this.hash(token) };
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
