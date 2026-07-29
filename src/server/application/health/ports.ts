// Application ports for the health check (docs/06 §6.10). Implemented in infrastructure so the use
// case stays framework-free and the components (DB, queue) can be swapped/mocked.
export abstract class DbHealthChecker {
  abstract ping(): Promise<boolean>;
}

export abstract class QueueHealthChecker {
  abstract status(): Promise<'ok' | 'down'>;
}
