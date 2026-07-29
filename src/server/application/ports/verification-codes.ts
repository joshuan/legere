// Six-digit email codes (docs/08 §8.1.3). Codes are stored as HMAC-SHA256(AUTH_SECRET, code) and
// compared in constant time, so a database leak yields nothing usable and comparison leaks no timing.
export abstract class VerificationCodes {
  abstract generate(): string;

  abstract hash(code: string): string;

  abstract matches(hash: string, code: string): boolean;
}
