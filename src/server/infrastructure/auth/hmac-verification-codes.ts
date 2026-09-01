import { Injectable } from '@nestjs/common';
import { HmacVerificationTokens } from '@joshuan/auth-adapters';
import { VerificationCodes } from '../../application/ports/verification-codes';
import { AppConfig } from '../config/app-config';

@Injectable()
export class HmacVerificationCodes extends VerificationCodes {
  private readonly shared: HmacVerificationTokens;

  constructor(config: AppConfig) {
    super();
    this.shared = new HmacVerificationTokens(config.get('AUTH_SECRET'));
  }

  generate(): string {
    return this.shared.generateCode();
  }

  hash(code: string): string {
    return this.shared.hashCode(code);
  }

  matches(hash: string, code: string): boolean {
    return this.shared.matchesCode(hash, code);
  }
}
