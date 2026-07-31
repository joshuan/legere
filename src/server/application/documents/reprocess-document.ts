import {
  DOCUMENT_STEPS,
  type DocumentStep,
  type ReprocessResponse,
} from '../../../shared/contracts/documents';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { JobQueue } from '../ports/job-queue';

// POST /api/documents/:id/reprocess (docs/07 §7.3, admin only). Re-runs the pipeline — or only the
// steps asked for, which is how an admin retries one failed step without paying for OCR again.
export class ReprocessDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly queue: JobQueue,
  ) {}

  async execute(documentId: string, steps?: readonly DocumentStep[]): Promise<ReprocessResponse> {
    const document = await this.documents.findById(documentId);
    if (document === null || document.deletedAt !== null) {
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }

    const requested = steps === undefined || steps.length === 0 ? DOCUMENT_STEPS : dedupe(steps);

    // The steps this run will redo go back to PENDING immediately, so the UI shows work in
    // progress from the moment the button is pressed rather than when a worker picks the job up.
    await this.documents.updateProcessing(documentId, {
      steps: Object.fromEntries(requested.map((step) => [step, 'PENDING'])),
      processingError: null,
      failedStep: null,
    });

    await this.queue.enqueue('document-process', { documentId, steps: requested });
    return { documentId, steps: [...requested] };
  }
}

// Keeps the canonical order of the pipeline regardless of how the request listed them.
function dedupe(steps: readonly DocumentStep[]): DocumentStep[] {
  const asked = new Set(steps);
  return DOCUMENT_STEPS.filter((step) => asked.has(step));
}
