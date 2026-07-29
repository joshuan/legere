// Per-email login backoff (docs/08 §8.4): after five consecutive failures each further attempt is
// refused for an exponentially growing window, so a stolen address cannot be brute-forced through
// the per-IP throttler by rotating source addresses.
//
// Like the per-email send caps of M2.3 this has no home in the schema of docs/04 §4.1 (there is no
// login-failure table), so the state is in memory and therefore per instance — the same limitation
// the per-IP throttler already documents (docs/12 §12.8 "Scaling later").
export abstract class LoginAttempts {
  // Milliseconds the caller must wait, or 0 when an attempt is allowed right now.
  abstract retryAfterMs(email: string): number;

  abstract recordFailure(email: string): void;

  // A successful login clears the streak.
  abstract clear(email: string): void;
}
