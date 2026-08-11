import type { DocumentEventType } from '../../../shared/contracts/enums';

// One thing that happened to a document (docs/03 §3.3.18). The document row carries the *current*
// state of every step; this is the only place that says how it got there — which run failed, what a
// value was before somebody corrected it, how long a step took.
export type DocumentEvent = {
  id: string;
  documentId: string;
  type: DocumentEventType;
  // Null is the pipeline acting on its own; a user id is somebody who pressed something.
  actorId: string | null;
  payload: DocumentEventPayload;
  at: Date;
};

// What an event needs to be readable. Every field is optional because every event type uses a
// different few of them, and a log must never fail to render because one entry is odd.
export type DocumentEventPayload = {
  step?: string | undefined;
  status?: string | undefined;
  reason?: string | undefined;
  error?: string | undefined;
  steps?: string[] | undefined;
  // Which service did a step, where it lives, and the id it was asked under (docs/03 §3.3.18).
  service?: string | undefined;
  endpoint?: string | undefined;
  requestId?: string | undefined;
  // What the step cost and what it produced (docs/03 §3.3.18).
  durationMs?: number | undefined;
  chars?: number | undefined;
  pages?: number | undefined;
  ocrUsed?: boolean | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  source?: string | undefined;
  library?: string | undefined;
  path?: string | undefined;
  // Field name → what it was and what it became, for a hand correction.
  changes?:
    | Record<string, { from?: string | null | undefined; to?: string | null | undefined }>
    | undefined;
};
