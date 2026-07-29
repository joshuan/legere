// Password hashing (docs/06 §6.3.3, docs/08 §8.1.5). Argon2id lives behind this port so
// domain/application never depend on the `argon2` package.
export abstract class PasswordHasher {
  abstract hash(password: string): Promise<string>;

  // Must not throw on a malformed/foreign hash — return false, so callers cannot distinguish
  // "no such user" from "wrong password" (docs/08 §8.1.4).
  abstract verify(hash: string, password: string): Promise<boolean>;
}
