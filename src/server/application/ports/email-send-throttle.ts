// Per-email send caps for register/start: ≤1 code per 60 s and ≤5 per day (docs/08 §8.4).
//
// The 60 s cap is derived from persisted state (the active EmailVerification's createdAt), but the
// daily cap has no home in the schema of docs/04 §4.1: a new request *replaces* the row, so send
// history is not retained. This port keeps that counter, with an in-memory implementation — the same
// per-instance limitation the per-IP throttler already has (docs/12 §12.8 "Scaling later").
export abstract class EmailSendThrottle {
  // True when another code may be sent to this address right now.
  abstract canSend(email: string): boolean;

  abstract record(email: string): void;
}
