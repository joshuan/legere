import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { PasswordHasher } from '../../application/ports/password-hasher';

// OWASP parameters from docs/08 §8.1.5: m=19456 KiB, t=2, p=1, Argon2id. The PHC string produced
// here is what lands in users.password_hash; prisma/seed.ts uses the same parameters.
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  hash(password: string): Promise<string> {
    return argon2.hash(password, ARGON2_OPTIONS);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // A malformed or foreign hash must read as "wrong password", never as an error: login
      // responses have to be indistinguishable (docs/08 §8.1.4).
      return false;
    }
  }
}
