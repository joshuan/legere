import { Injectable } from '@nestjs/common';
import { AsyncCallContext, correlationHeaders } from '@joshuan/observability';
import { CallContext } from '../../application/ports/call-context';

@Injectable()
export class AsyncLocalCallContext extends CallContext {
  private readonly shared = new AsyncCallContext();

  run<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    return this.shared.run(requestId, work);
  }

  get current(): string | null {
    return this.shared.current;
  }
}

export function callHeaders(): Record<string, string> {
  return correlationHeaders();
}
