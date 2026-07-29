// Time source (docs/06 §6.3.3). Injected everywhere instead of calling Date.now() directly, so use
// cases and job handlers can be tested deterministically (TTLs, expiry, backoff).
export abstract class Clock {
  abstract now(): Date;
}
