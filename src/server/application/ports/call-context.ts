// The one id that ties a pipeline step to the requests it makes. The application decides what a
// call is — one step of one document — and the infrastructure decides how the id reaches the
// services that step talks to, so a line in the document's log can be found in Stirling's own
// (docs/03 §3.3.18).
export abstract class CallContext {
  abstract run<T>(requestId: string, work: () => Promise<T>): Promise<T>;

  // The call in progress, or null outside one. Read rather than passed, because the step that
  // records an outcome is several frames away from the one that started it.
  abstract get current(): string | null;
}
