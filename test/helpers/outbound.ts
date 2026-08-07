import { vi, type MockInstance } from 'vitest';

// 🔒 Stubs for the outbound-call bounds of SEC-17: every call this server makes to a sibling
// container or a third party carries a timeout and reads its answer through a bound (docs/05 §5.4).
//
// A real `AbortSignal.timeout(120_000)` cannot be waited out in a test, and it does not use the
// global `setTimeout` that fake timers replace. So the static is stubbed instead: the durations the
// code asks for are recorded — a bound that is not there records nothing — and the signal handed
// back is one the test fires itself, which is what a timeout does when it expires.
export type TimeoutStub = {
  // Every duration asked for, in the order they were asked for.
  requested: () => number[];
  // Fire them, the way the clock would have.
  expire: () => void;
};

export function stubTimeouts(): TimeoutStub {
  const requested: number[] = [];
  const controllers: AbortController[] = [];

  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    requested.push(ms);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });

  return {
    requested: () => [...requested],
    expire: () => {
      for (const controller of controllers) {
        controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
      }
    },
  };
}

// An upstream that accepts the request and then says nothing, for ever — the wedged container and
// the slow drip of SEC-17. It settles only when the caller's own signal aborts, so a call made
// without one simply never returns: the test then hangs and fails on its own timeout, which is
// precisely the production failure being guarded against.
export function neverAnswers(): MockInstance<typeof fetch> {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) return;
      const fail = (): void => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  });
}

// An upstream that answers, and answers, and never stops — the hostile container of SEC-17 returning
// a multi-gigabyte body into a process that is also serving pages. `arrayBuffer()` or `json()` on
// this never returns and grows without limit; a bounded read refuses it at the first chunk past the
// bound. `produced` says how many chunks were ever asked for, so a test can show the refusal cost
// one chunk rather than the whole body.
export function endlessBody(chunkBytes = 64 * 1024): {
  response: Response;
  produced: () => number;
} {
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      chunks += 1;
      // Digits, so the answer stays plausible JSON-ish text right up to the point it is refused.
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x31));
    },
  });
  return { response: new Response(body), produced: () => chunks };
}
