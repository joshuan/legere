import { Injectable } from '@nestjs/common';
import { Clock } from '../../application/ports/clock';
import { EmailSendThrottle } from '../../application/ports/email-send-throttle';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_CODES_PER_DAY = 5;

// Sliding 24 h window per address (docs/08 §8.4). In-memory, so the cap is per instance and resets
// on restart; the 60 s cap that guards against rapid-fire abuse is enforced from persisted state in
// StartRegistration, which survives both.
@Injectable()
export class InMemoryEmailSendThrottle extends EmailSendThrottle {
  private readonly sends = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {
    super();
  }

  canSend(email: string): boolean {
    return this.recent(email).length < MAX_CODES_PER_DAY;
  }

  record(email: string): void {
    const recent = this.recent(email);
    recent.push(this.clock.now().getTime());
    this.sends.set(email, recent);
  }

  private recent(email: string): number[] {
    const cutoff = this.clock.now().getTime() - DAY_MS;
    const kept = (this.sends.get(email) ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) this.sends.delete(email);
    else this.sends.set(email, kept);
    return kept;
  }
}
