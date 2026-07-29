import { Injectable } from '@nestjs/common';
import { QueueHealthChecker } from '../../application/health/ports';

// Stub until pg-boss lands (M3.2), at which point this reads real queue state (docs/06 §6.10).
@Injectable()
export class StubQueueHealthChecker extends QueueHealthChecker {
  status(): Promise<'ok' | 'down'> {
    return Promise.resolve('ok');
  }
}
