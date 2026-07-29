// Opaque session/bearer tokens (docs/06 §6.3.3, docs/08 §8.2). The plaintext token goes to the
// client (cookie or URL); only its hash is stored, so a database leak yields no usable credential.
export type GeneratedToken = { token: string; hash: string };

export abstract class SessionTokens {
  abstract generate(): GeneratedToken;

  abstract hash(token: string): string;
}
