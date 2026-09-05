import { DOCUMENT_STEPS, type DocumentStep } from '../../../shared/contracts/documents';
import type { StepStatus } from '../../../shared/contracts/enums';
import { heldSteps } from '../../domain/entities/pipeline-pause';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { ReprocessDocument } from '../documents/reprocess-document';

type ResumeCandidateStatus = Extract<StepStatus, 'PENDING' | 'QUEUED'>;

export type ResumeReleasedPipelineWorkResult = {
  // ProcessingControlPlane maps non-zero entries to its public `resumed[]`. `hasMore` and warnings
  // are intentionally richer application evidence: either lifts apply to APPLIED_WITH_WARNINGS.
  documents: number;
  byStep: Record<DocumentStep, number>;
  hasMore: boolean;
  warnings: string[];
};

export type ResumeReleasedPipelineWorkInput = {
  before: ReadonlySet<DocumentStep>;
  after: ReadonlySet<DocumentStep>;
  actorId?: string | undefined;
};

// Applies the other half of a pipeline-step resume. Removing a configured pause is one setting
// change, but what it releases is document-specific: an unsettled canonical holds preview and
// markdown (and, through markdown, the three reading steps), while a canonical with an answer holds
// none of them. The effective sets are therefore compared against each current document rather than
// inferred from the configured step alone.
export class ResumeReleasedPipelineWork {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly reprocess: ReprocessDocument,
    private readonly maxDocuments: number,
  ) {}

  async execute(input: ResumeReleasedPipelineWorkInput): Promise<ResumeReleasedPipelineWorkResult> {
    const releasedControls = DOCUMENT_STEPS.filter(
      (step) => input.before.has(step) && !input.after.has(step),
    );
    const byStep = emptyStepCounts();
    if (releasedControls.length === 0) {
      return { documents: 0, byStep, hasMore: false, warnings: [] };
    }

    // Both statuses are unsatisfied work. PENDING is the ordinary state of work created while a
    // pause was active; QUEUED covers a job delivered just after the pause was applied and completed
    // without touching the held step. Each query asks for one beyond the processing bound so the
    // caller can report honestly that the hourly safety sweep still has a remainder to drain.
    const statuses: readonly ResumeCandidateStatus[] = ['PENDING', 'QUEUED'];
    const batches = await Promise.all(
      releasedControls.flatMap((step) =>
        statuses.map((status) =>
          this.documents.listIdsByStepStatus(step, status, this.maxDocuments + 1),
        ),
      ),
    );
    const candidates = interleaveUnique(batches, this.maxDocuments + 1);
    let hasMore = candidates.length > this.maxDocuments;
    let missing = 0;
    let repaused = 0;
    let enqueuedDocuments = 0;

    // Sequential on purpose: each item writes document state, creates one job and records one event.
    // The queue will supply the parallelism when the jobs are consumed; issuing a settings command
    // should not manufacture a burst of competing writes itself.
    for (const documentId of candidates.slice(0, this.maxDocuments)) {
      const document = await this.documents.findById(documentId);
      if (document === null || document.deletedAt !== null) {
        missing += 1;
        continue;
      }

      const heldBefore = heldSteps(input.before, document);
      const heldAfter = heldSteps(input.after, document);
      const released = DOCUMENT_STEPS.filter(
        (step) =>
          heldBefore.has(step) &&
          !heldAfter.has(step) &&
          (document.steps[step] === 'PENDING' || document.steps[step] === 'QUEUED'),
      );
      if (released.length === 0) continue;

      try {
        const result = await this.reprocess.execute(documentId, released, input.actorId);
        enqueuedDocuments += 1;
        for (const step of result.steps) byStep[step] += 1;
      } catch (error) {
        // Settings may change again while a large resume is walking its bounded batch. That is not
        // a failed command and must not override the newer pause; leave the row unstarted and tell
        // the control plane there is work for a later sweep/release.
        if (error instanceof ConflictError && error.code === 'STEPS_PAUSED') {
          repaused += 1;
          hasMore = true;
          continue;
        }
        // The candidate query excludes deleted rows, but deletion can win the race before find or
        // before ReprocessDocument's own read. Either outcome is harmless and summarized once.
        if (error instanceof NotFoundError && error.code === 'DOCUMENT_NOT_FOUND') {
          missing += 1;
          continue;
        }
        throw error;
      }
    }

    const warnings: string[] = [];
    if (missing > 0) warnings.push(`${missing} document(s) disappeared while work was resumed`);
    if (repaused > 0) {
      warnings.push(`${repaused} document(s) remained held because pipeline pauses changed again`);
    }
    return { documents: enqueuedDocuments, byStep, hasMore, warnings };
  }
}

function emptyStepCounts(): Record<DocumentStep, number> {
  return {
    canonical: 0,
    preview: 0,
    markdown: 0,
    analysis: 0,
    fields: 0,
    vectorization: 0,
  };
}

// Fair across released controls and statuses: a full first page of canonical candidates must not
// hide every markdown candidate when both switches were released together. The limit also bounds
// the number of document rows the use case subsequently reads and mutates.
function interleaveUnique(batches: readonly string[][], limit: number): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...batches.map((batch) => batch.length));
  for (let index = 0; index < longest && ids.length < limit; index += 1) {
    for (const batch of batches) {
      const id = batch[index];
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length === limit) break;
    }
  }
  return ids;
}
