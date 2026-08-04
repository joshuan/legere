import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { CallContext } from '../../application/ports/call-context';

// Module-level rather than per-instance: the adapters that put the id on the wire are singletons
// shared by every job, and threading a parameter through eight port methods would be a worse answer
// to the same question.
const storage = new AsyncLocalStorage<string>();

@Injectable()
export class AsyncLocalCallContext extends CallContext {
  run<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    return storage.run(requestId, work);
  }

  get current(): string | null {
    return storage.getStore() ?? null;
  }
}

// What an outgoing call carries, so the service on the other end writes the same id into its own
// log. The same header our HTTP layer answers with (docs/06 §6.7); empty outside a call, because
// inventing one there would tie a line to nothing.
export function callHeaders(): Record<string, string> {
  const id = storage.getStore();
  return id === undefined ? {} : { 'X-Request-Id': id };
}
