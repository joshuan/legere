// Job handlers (docs/06 §6.3.2) are use cases with a single `handle(payload)`.
//
// The payload arrives as `unknown` because it comes back from the queue as stored JSON: each handler
// validates it with its own Zod schema, which docs/14 §14.7 places next to the consumer rather than
// in the shared contracts. That keeps the registry heterogeneous without a type assertion.
//
// Every handler must be idempotent: pg-boss delivers at-least-once, so re-delivery of the same
// payload must not duplicate work or corrupt state (docs/05 §5.4).
export abstract class JobHandler {
  abstract handle(payload: unknown): Promise<void>;
}
