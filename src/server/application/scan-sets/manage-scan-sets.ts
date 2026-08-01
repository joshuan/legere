import type {
  CreateScanSetRequest,
  ListScanSetsResponse,
  ScanSetDetailDto,
  ScanSetDto,
  UpdateScanSetRequest,
} from '../../../shared/contracts/scan-sets';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../domain/errors/domain-error';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type {
  ScanSetRepository,
  ScanSetWithItems,
} from '../../domain/repositories/scan-set.repository';
import type { Clock } from '../ports/clock';
import type { JobQueue } from '../ports/job-queue';
import type { UnitOfWork } from '../ports/unit-of-work';

// Items may be edited only while the set is DRAFT or FAILED (docs/03 §3.3.16): a merge in flight
// must not have the ground moved under it.
const EDITABLE: ReadonlySet<ScanSetWithItems['status']> = new Set(['DRAFT', 'FAILED']);

export class ListScanSets {
  constructor(private readonly scanSets: ScanSetRepository) {}

  async execute(viewer: Viewer): Promise<ListScanSetsResponse> {
    const rows = await this.scanSets.listForUser(viewer.id);
    return { items: rows.map(toDto) };
  }
}

export class CreateScanSet {
  constructor(
    private readonly scanSets: ScanSetRepository,
    private readonly documents: DocumentRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(viewer: Viewer, input: CreateScanSetRequest): Promise<ScanSetDetailDto> {
    await assertImagesReadable(this.documents, viewer, input.items);

    const created = await this.unitOfWork.run(async (tx) => {
      const scanSet = await this.scanSets.create(
        { name: input.name, createdById: viewer.id, cropMode: input.cropMode },
        tx,
      );
      await this.scanSets.replaceItems(scanSet.id, input.items, tx);
      return scanSet;
    });

    const withItems = await this.scanSets.findById(created.id);
    if (withItems === null) throw new NotFoundError('SCANSET_NOT_FOUND', 'Scan set not found');
    return toDetailDto(withItems);
  }
}

export class GetScanSet {
  constructor(private readonly scanSets: ScanSetRepository) {}

  async execute(viewer: Viewer, id: string): Promise<ScanSetDetailDto> {
    return toDetailDto(await requireOwned(this.scanSets, viewer, id));
  }
}

export class UpdateScanSet {
  constructor(
    private readonly scanSets: ScanSetRepository,
    private readonly documents: DocumentRepository,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    id: string,
    input: UpdateScanSetRequest,
  ): Promise<ScanSetDetailDto> {
    const scanSet = await requireOwned(this.scanSets, viewer, id);
    if (!EDITABLE.has(scanSet.status)) {
      throw new ConflictError(
        'SCANSET_INVALID_STATE',
        `A ${scanSet.status} scan set cannot be edited`,
      );
    }
    if (input.items !== undefined) {
      await assertImagesReadable(this.documents, viewer, input.items);
    }

    await this.unitOfWork.run(async (tx) => {
      await this.scanSets.update(
        id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.cropMode === undefined ? {} : { cropMode: input.cropMode }),
        },
        tx,
      );
      if (input.items !== undefined) await this.scanSets.replaceItems(id, input.items, tx);
    });

    const updated = await this.scanSets.findById(id);
    if (updated === null) throw new NotFoundError('SCANSET_NOT_FOUND', 'Scan set not found');
    return toDetailDto(updated);
  }
}

// POST /api/scan-sets/:id/merge (docs/05 §5.6): DRAFT/FAILED → QUEUED, and the job goes with it.
export class MergeScanSet {
  constructor(
    private readonly scanSets: ScanSetRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(viewer: Viewer, id: string): Promise<ScanSetDto> {
    const scanSet = await requireOwned(this.scanSets, viewer, id);
    if (!EDITABLE.has(scanSet.status)) {
      throw new ConflictError(
        'SCANSET_INVALID_STATE',
        `A ${scanSet.status} scan set cannot be merged`,
      );
    }
    if (scanSet.items.length === 0) {
      throw new ConflictError('SCANSET_INVALID_STATE', 'A scan set needs at least one page');
    }

    const queued = await this.unitOfWork.run(async (tx) => {
      // The error from the previous attempt goes with the retry, or the UI would show a failure
      // that no longer describes anything.
      const updated = await this.scanSets.update(id, { status: 'QUEUED', error: null }, tx);
      await this.queue.enqueueAfterTx(tx, 'scanset-merge', { scanSetId: id }, { singletonKey: id });
      return updated;
    });

    return toDto({ ...queued, items: scanSet.items });
  }
}

export class DeleteScanSet {
  constructor(
    private readonly scanSets: ScanSetRepository,
    private readonly clock: Clock,
  ) {}

  async execute(viewer: Viewer, id: string): Promise<{ ok: true }> {
    await requireOwned(this.scanSets, viewer, id);
    // The result document stays: it is a document in its own right now (docs/07 §7.3).
    await this.scanSets.softDelete(id, this.clock.now());
    return { ok: true };
  }
}

// A scan set is its creator's; an admin may act on one for maintenance (docs/03 §3.4).
async function requireOwned(
  scanSets: ScanSetRepository,
  viewer: Viewer,
  id: string,
): Promise<ScanSetWithItems> {
  const scanSet = await scanSets.findById(id);
  if (scanSet === null) throw new NotFoundError('SCANSET_NOT_FOUND', 'Scan set not found');
  if (viewer.role !== 'ADMIN' && scanSet.createdById !== viewer.id) {
    // Somebody else's scan set is not theirs to know about.
    throw new NotFoundError('SCANSET_NOT_FOUND', 'Scan set not found');
  }
  return scanSet;
}

// 🔒 Every page has to be an image this user can read (docs/03 §3.3.17) — a scan set is not a way
// to reach a document you cannot open, nor to feed the merger something it cannot use.
async function assertImagesReadable(
  documents: DocumentRepository,
  viewer: Viewer,
  documentIds: readonly string[],
): Promise<void> {
  for (const documentId of documentIds) {
    const detail = await documents.findReadableById(documentId, viewer);
    if (detail === null) throw new ForbiddenError('One of the pages is not available to you');
    if (!detail.document.mimeType.startsWith('image/')) {
      // 422 rather than 409: the request is well-formed but asks for something that cannot be a
      // page (docs/07 §7.2).
      throw new UnprocessableError(
        'SCANSET_ITEM_NOT_IMAGE',
        'Only images can be pages of a scan set',
      );
    }
  }
}

function toDto(scanSet: ScanSetWithItems): ScanSetDto {
  return {
    id: scanSet.id,
    name: scanSet.name,
    status: scanSet.status,
    cropMode: scanSet.cropMode,
    itemCount: scanSet.items.length,
    resultDocumentId: scanSet.resultDocumentId,
    error: scanSet.error,
    createdAt: scanSet.createdAt.toISOString(),
  };
}

function toDetailDto(scanSet: ScanSetWithItems): ScanSetDetailDto {
  return {
    ...toDto(scanSet),
    items: scanSet.items.map((item) => ({
      documentId: item.documentId,
      position: item.position,
      title: item.title,
      hasPreview: item.hasPreview,
    })),
  };
}
