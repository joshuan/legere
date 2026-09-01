import { Injectable } from '@nestjs/common';
import { CryptoSessionTokens as SharedCryptoSessionTokens } from '@joshuan/auth-adapters';
import { SessionTokens, type GeneratedToken } from '../../application/ports/session-tokens';

@Injectable()
export class CryptoSessionTokens extends SessionTokens {
  private readonly shared = new SharedCryptoSessionTokens();

  generate(): GeneratedToken {
    return this.shared.issue();
  }

  hash(token: string): string {
    return this.shared.hash(token);
  }
}
