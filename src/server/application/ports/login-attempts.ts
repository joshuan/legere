// Per-email login backoff (docs/08 §8.4): consecutive *failures* against one address are counted,
// and from the fifth each further failure is answered as a rate limit for an exponentially growing
// window, so a stolen address cannot be brute-forced through the per-IP throttler by rotating
// source addresses. It is a brake on guessing, not a gate on signing in — the password is verified
// before any of this is consulted, so a correct one is never refused however long the streak grew.
//
// Like the per-email send caps of M2.3 this has no home in the schema of docs/04 §4.1 (there is no
// login-failure table), so the state is in memory and therefore per instance and lost on restart —
// the same limitation the per-IP throttler already documents (docs/12 §12.8 "Scaling later"), and
// recorded as a deliberate one in docs/08 §8.4.
export abstract class LoginAttempts {
  // Milliseconds the caller must wait, or 0 when an attempt is allowed right now. Read only after a
  // failure has been recorded; nothing may consult it in front of the password check.
  abstract retryAfterMs(email: string): number;

  abstract recordFailure(email: string): void;

  // A successful login clears the streak.
  abstract clear(email: string): void;
}
