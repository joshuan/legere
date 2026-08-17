import type {
  ReprocessByStepRequest,
  ReprocessByStepResponse,
} from '../../../shared/contracts/queue';
import { ConflictError } from '../../domain/errors/domain-error';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { ReprocessDocument } from '../documents/reprocess-document';
import type { QueueSettings } from './queue-settings';

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
    private readonly queueSettings: QueueSettings,
    // Bounded per call (`QUEUE_REPROCESS_MAX`, docs/12 §12.4): a large archive drains in batches
    // rather than in one indigestible push, and the answer says how many this batch took.
    private readonly maxPerCall: number,
  ) {}

  async execute(input: ReprocessByStepRequest, actorId?: string): Promise<ReprocessByStepResponse> {
    // Naming a paused step is refused here, before anything is listed, so the answer is the reason
    // rather than `enqueued: 0` (docs/05 §5.4d, docs/07 §7.3).
    const paused = await this.queueSettings.heldSteps();
    if (input.step !== undefined && paused.has(input.step)) {
      throw new ConflictError('STEPS_PAUSED', `The ${input.step} step is paused`);
    }

    const ids = await this.documents.listIdsByStepStatus(input.step, input.status, this.maxPerCall);

    // One at a time: this is repair work on a queue that will run it in parallel anyway, and a
    // burst of concurrent writes here buys nothing but contention.
    //
    // No step named means the whole pipeline of each document, which is what `undefined` already
    // means to the single reprocess — so the widest question here and the button on one document's
    // own page end up asking for exactly the same work.
    let enqueued = 0;
    for (const documentId of ids) {
      try {
        await this.reprocess.execute(
          documentId,
          input.step === undefined ? undefined : [input.step],
          actorId,
        );
        enqueued += 1;
      } catch (error) {
        // The whole-pipeline question over a document the pause leaves nothing to run — an
        // unextracted document while `markdown` is held, say. That is one document skipped and not a
        // failed repair, so the loop goes on and the count says what actually happened
        // (docs/05 §5.4d).
        if (error instanceof ConflictError && error.code === 'STEPS_PAUSED') continue;
        throw error;
      }
    }

    return { enqueued };
  }
}
