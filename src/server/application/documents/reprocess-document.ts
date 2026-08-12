import {
  DOCUMENT_STEPS,
  type DocumentStep,
  type ReprocessResponse,
} from '../../../shared/contracts/documents';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { JobQueue } from '../ports/job-queue';

// POST /api/documents/:id/reprocess (docs/07 §7.3, admin only). Re-runs the pipeline — or only the
// steps asked for, which is how an admin retries one failed step without paying for OCR again.
export class ReprocessDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
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

    const requested = steps === undefined || steps.length === 0 ? DOCUMENT_STEPS : dedupe(steps);

    // QUEUED, not PENDING: a job is about to exist for these steps, and the two words now say which
    // of those it is (docs/03 §3.3.10). The UI shows work from the moment the button is pressed
    // rather than when a worker picks the job up.
    await this.documents.updateProcessing(documentId, {
      steps: Object.fromEntries(requested.map((step) => [step, 'QUEUED'])),
      processingError: null,
      failedStep: null,
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
