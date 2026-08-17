import { DOCUMENT_STEPS, type DocumentStep } from '../../../shared/contracts/documents';
import type { StepStatus } from '../../../shared/contracts/enums';
import type { DocumentSteps } from './document';

// What one document of a paused instance is not allowed to run (docs/05 §5.4d).
//
// A paused step is *held*: the job runs, the steps beside it run, and this one is left exactly as it
// was — nothing written against it, because a step that has not run has reached no verdict about the
// document. Which is the whole difference between pausing a step and turning it off: `SKIPPED` is an
// outcome, and an outcome has to be undone by hand on every document that collected it.
//
// The rule below is the second half of that promise. A held step leaves the steps that read it with
// no input, and those must be held too — otherwise the pause would write the very verdicts it exists
// to avoid: a preview `FAILED` because there is no canonical, a `fields` step `SKIPPED / NO_SCHEMA`
// because the analysis that decides the type never ran.
export function heldSteps(
  paused: ReadonlySet<DocumentStep>,
  document: { steps: DocumentSteps; typeId: string | null },
): ReadonlySet<DocumentStep> {
  const held = new Set(DOCUMENT_STEPS.filter((step) => paused.has(step)));
  if (held.size === 0) return held;

  // 🔒 Only where the input is missing *because of the pause*. An input missing for a reason of its
  // own is not this rule's business: a canonical that failed still fails the steps that read it and a
  // markdown that was skipped still passes its reason down (docs/03 §3.3.10), because those are facts
  // about the document rather than consequences of a switch somebody flicked.
  if (held.has('canonical') && !settled(document.steps.canonical)) {
    held.add('preview');
    held.add('markdown');
  }
  if (held.has('markdown') && !settled(document.steps.markdown)) {
    held.add('analysis');
    held.add('fields');
    held.add('vectorization');
  }
  // The fields step reads the document *under its type*, and for most documents the analysis is what
  // decides that type. One that already carries a type — chosen by a person, or read by an earlier
  // run — has its fields extracted as usual; one that does not would be marked as having no schema,
  // which would be a verdict about the type of a document nothing has looked at yet.
  if (held.has('analysis') && !settled(document.steps.analysis) && document.typeId === null) {
    held.add('fields');
  }
  return held;
}

// Whether a step has an answer of its own — any answer. `DONE` left an artifact for the steps after
// it; `FAILED` and `SKIPPED` left a reason, and a reason is an input too: it is what the steps that
// read this one settle themselves by (docs/05 §5.5).
function settled(status: StepStatus): boolean {
  return status === 'DONE' || status === 'FAILED' || status === 'SKIPPED';
}
