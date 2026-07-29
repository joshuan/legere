import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { VerificationCodes } from '../../application/ports/verification-codes';
import { AppConfig } from '../config/app-config';

const CODE_DIGITS = 6;

@Injectable()
export class HmacVerificationCodes extends VerificationCodes {
  private readonly secret: string;

  constructor(config: AppConfig) {
    super();
    this.secret = config.get('AUTH_SECRET');
  }

  // randomInt is CSPRNG-backed and unbiased; padded so every code is exactly six digits.
  generate(): string {
    return randomInt(0, 10 ** CODE_DIGITS)
      .toString()
      .padStart(CODE_DIGITS, '0');
  }

  hash(code: string): string {
    return createHmac('sha256', this.secret).update(code).digest('hex');
  }

  matches(hash: string, code: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(this.hash(code), 'hex');
    // Equal length by construction (both sha256), but guard anyway: timingSafeEqual throws otherwise.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}
