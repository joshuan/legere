import { Injectable } from '@nestjs/common';
import { Clock } from '../../application/ports/clock';
import { EmailSendThrottle } from '../../application/ports/email-send-throttle';
import type { VerificationPurpose } from '../../domain/entities/email-verification';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_CODES_PER_DAY = 5;

// Sliding 24 h window per address (docs/08 §8.4). 🔒 In-memory, so the cap is per instance and
// resets on restart — a deliberate limitation, recorded with its cost in docs/08 §8.4. The 60 s cap
// that guards against rapid-fire abuse is enforced from persisted state in StartRegistration, which
// survives both, so a restart loses the daily ceiling and not the floor under it.
@Injectable()
export class InMemoryEmailSendThrottle extends EmailSendThrottle {
  private readonly sends = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {
    super();
  }

  canSend(email: string, purpose: VerificationPurpose): boolean {
    return this.recent(keyOf(email, purpose)).length < MAX_CODES_PER_DAY;
  }

  record(email: string, purpose: VerificationPurpose): void {
    const key = keyOf(email, purpose);
    const recent = this.recent(key);
    recent.push(this.clock.now().getTime());
    this.sends.set(key, recent);
  }

  private recent(key: string): number[] {
    const cutoff = this.clock.now().getTime() - DAY_MS;
    const kept = (this.sends.get(key) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.sends.delete(key);
    else this.sends.set(key, kept);
    return kept;
  }
}

// One counter per address *and* purpose, so sign-up letters cannot spend the allowance a password
// reset needs (docs/08 §8.4).
function keyOf(email: string, purpose: VerificationPurpose): string {
  return `${purpose}:${email}`;
}
