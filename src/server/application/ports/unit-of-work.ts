// Transaction boundary port (docs/06 §6.3.3–6.3.4). Every multi-write use case runs inside
// UnitOfWork.run; repositories accept the handle so all writes share one transaction.
//
// The handle is opaque to domain/application (framework-free rule): only infrastructure
// repositories know it is a Prisma transaction client. Job enqueueing inside a transaction uses
// JobQueue.enqueueAfterTx (M3.2) so the entity write and the job insert commit atomically.
export type TransactionHandle = unknown;

export abstract class UnitOfWork {
  abstract run<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T>;
}
