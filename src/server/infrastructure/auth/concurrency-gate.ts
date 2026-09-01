import { ConcurrencyGate as SharedConcurrencyGate } from '@joshuan/auth-adapters';

// Product callers keep the small API they already use; queue exhaustion is now bounded instead of
// allowing an unbounded authentication flood to allocate promises forever.
export class ConcurrencyGate extends SharedConcurrencyGate {
  constructor(limit: number) {
    super(limit, 128);
  }
}
