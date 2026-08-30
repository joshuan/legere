// Transaction boundary port (docs/06 §6.3.3–6.3.4). Every multi-write use case runs inside
// UnitOfWork.run; repositories accept the handle so all writes share one transaction.
//
// The handle is opaque to domain/application (framework-free rule): only infrastructure
// repositories know it is a Prisma transaction client. Job enqueueing inside a transaction uses
// JobQueue.enqueueAfterTx (M3.2) so the entity write and the job insert commit atomically.
export type TransactionHandle = unknown;

// What a caller may say about the time its work needs (docs/06 §6.3.4). Milliseconds and nothing
// else: the driver's option names are the adapter's business, and the layers above it may not learn
// them. A caller that says nothing gets the adapter's default, which is what every caller but one
// wants — the bound belongs to the work that asked for it, never to everybody.
export interface TransactionBounds {
  // The whole run: opening the transaction, the callback, and the commit at the end of it.
  readonly timeoutMs: number;
}

export abstract class UnitOfWork {
  abstract run<T>(
    fn: (tx: TransactionHandle) => Promise<T>,
    bounds?: TransactionBounds,
  ): Promise<T>;
}
