import {
  DOCUMENT_STEPS,
  type DocumentStep,
  type ReprocessResponse,
} from '../../../shared/contracts/documents';
import { clearsRecordedFailure } from '../../domain/entities/document';
import { heldSteps } from '../../domain/entities/pipeline-pause';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { JobQueue } from '../ports/job-queue';
import type { QueueSettings } from '../queue/queue-settings';

// POST /api/documents/:id/reprocess (docs/07 §7.3, admin only). Re-runs the pipeline — or only the
// steps asked for, which is how an admin retries one failed step without paying for OCR again.
export class ReprocessDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly queueSettings: QueueSettings,
  ) {}

  async execute(
    documentId: string,
    steps?: readonly DocumentStep[],
    actorId?: string,
    analyseInFull = false,
  ): Promise<ReprocessResponse> {
    const document = await this.documents.findById(documentId);
    if (document === null || document.deletedAt !== null) {
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }

    const asked = steps === undefined || steps.length === 0 ? DOCUMENT_STEPS : dedupe(steps);
    // 🔒 A pause outranks a person asking (docs/05 §5.4d). The held steps leave the request — with
    // the ones the pause deprives of an input, since enqueueing those would be a job that writes
    // nothing — and a request that had nothing else in it is refused rather than answered with work
    // that will not happen. A switch other screens can talk around is a switch nobody can trust.
    const held = heldSteps(await this.queueSettings.heldSteps(), document);
    const requested = asked.filter((step) => !held.has(step));
    if (requested.length === 0) {
      throw new ConflictError('STEPS_PAUSED', 'Every step asked for is paused');
    }

    // QUEUED, not PENDING: a job is about to exist for these steps, and the two words now say which
    // of those it is (docs/03 §3.3.10). The UI shows work from the moment the button is pressed
    // rather than when a worker picks the job up.
    await this.documents.updateProcessing(documentId, {
      steps: Object.fromEntries(requested.map((step) => [step, 'QUEUED'])),
      // 🔒 The recorded reason goes only where this run may replace it. Asking for the analysis of a
      // document whose extraction failed must not empty the one field that says why there is nothing
      // to analyse (docs/07 §7.3, 03 §3.3.10) — and the handler applies the same rule when it runs.
      ...(clearsRecordedFailure(document.failedStep, new Set(requested))
        ? { processingError: null, failedStep: null }
        : {}),
    });

    // Keyed by the document: whatever asked for the run — this route or a repair over five hundred
    // of them at once — a document is one piece of work in the queue (docs/05 §5.4).
    await this.queue.enqueue(
      'document-process',
      { documentId, steps: requested, ...(analyseInFull ? { analyseInFull: true } : {}) },
      { singletonKey: documentId },
    );
    // Who asked for it and for which steps: a document that was reprocessed three times is a
    // document somebody was fighting with, and that is worth being able to see (docs/03 §3.3.18).
    await this.events.record({
      documentId,
      type: 'QUEUED',
      ...(actorId === undefined ? {} : { actorId }),
      payload: { steps: [...requested] },
    });
    return { documentId, steps: [...requested] };
  }
}

// Keeps the canonical order of the pipeline regardless of how the request listed them.
function dedupe(steps: readonly DocumentStep[]): DocumentStep[] {
  const asked = new Set(steps);
  return DOCUMENT_STEPS.filter((step) => asked.has(step));
}
