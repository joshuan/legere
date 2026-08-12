import type {
  ReprocessByStepRequest,
  ReprocessByStepResponse,
} from '../../../shared/contracts/queue';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { ReprocessDocument } from '../documents/reprocess-document';

// POST /api/admin/queue/reprocess (docs/07 §7.3, docs/11 §11.13): "the previews failed, run them
// again" — every document whose named step sits in that status, instead of opening five hundred
// documents and pressing the same button in each.
//
// Each document goes back through the ordinary reprocess, so a repair and a single retry leave
// exactly the same trace: the step returns to PENDING and the document's history records who asked.
export class ReprocessDocumentsByStep {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly reprocess: ReprocessDocument,
    // Bounded per call (`QUEUE_REPROCESS_MAX`, docs/12 §12.4): a large archive drains in batches
    // rather than in one indigestible push, and the answer says how many this batch took.
    private readonly maxPerCall: number,
  ) {}

  async execute(input: ReprocessByStepRequest, actorId?: string): Promise<ReprocessByStepResponse> {
    const ids = await this.documents.listIdsByStepStatus(input.step, input.status, this.maxPerCall);

    // One at a time: this is repair work on a queue that will run it in parallel anyway, and a
    // burst of concurrent writes here buys nothing but contention.
    //
    // No step named means the whole pipeline of each document, which is what `undefined` already
    // means to the single reprocess — so the widest question here and the button on one document's
    // own page end up asking for exactly the same work.
    for (const documentId of ids) {
      await this.reprocess.execute(
        documentId,
        input.step === undefined ? undefined : [input.step],
        actorId,
      );
    }

    return { enqueued: ids.length };
  }
}
