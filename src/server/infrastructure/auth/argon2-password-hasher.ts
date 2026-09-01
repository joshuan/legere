import { Injectable } from '@nestjs/common';
import { Argon2PasswordHasher as SharedArgon2PasswordHasher } from '@joshuan/auth-adapters';
import { PasswordHasher } from '../../application/ports/password-hasher';

@Injectable()
export class Argon2PasswordHasher extends PasswordHasher {
  private readonly shared = new SharedArgon2PasswordHasher({
    concurrency: 2,
    maxQueued: 32,
  });

  hash(password: string): Promise<string> {
    return this.shared.hash(password);
  }

  verify(hash: string, password: string): Promise<boolean> {
    return this.shared.verify(hash, password);
  }
}
