import type {
  ListScanRunsResponse,
  ScanRunDto,
  TriggerScanResponse,
} from '../../../shared/contracts/libraries';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import type { ScanRun, ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import type { JobQueue } from '../ports/job-queue';
import type { UnitOfWork } from '../ports/unit-of-work';

const USER_PRIORITY = 10;

// POST /api/admin/libraries/:id/scan — "Scan now" (docs/07 §7.3). Answers `alreadyRunning` rather
// than queueing a second pass: one scan per library at a time (docs/05 §5.2).
export class TriggerScan {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly scanRuns: ScanRunRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(libraryId: string): Promise<TriggerScanResponse> {
    const library = await this.libraries.findById(libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new NotFoundError('LIBRARY_NOT_FOUND', 'Library not found');
    }

    return this.unitOfWork.run(async (tx) => {
      // startRun returns null when the scan_runs_running_uq index refuses a second RUNNING row —
      // the database decides, so two simultaneous clicks cannot both start a scan (docs/04 §4.3).
      const run = await this.scanRuns.startRun(library.id, tx);
      if (run === null) return { alreadyRunning: true };

      await this.queue.enqueueAfterTx(
        tx,
        'library-scan',
        { libraryId: library.id, scanRunId: run.id },
        { singletonKey: library.id, priority: USER_PRIORITY },
      );
      return { scanRunId: run.id };
    });
  }
}

// GET /api/admin/libraries/:id/scans — the journal, newest first.
export class ListScanRuns {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly scanRuns: ScanRunRepository,
  ) {}

  async execute(
    libraryId: string,
    query: { limit: number; cursor?: string | undefined },
  ): Promise<ListScanRunsResponse> {
    const library = await this.libraries.findById(libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new NotFoundError('LIBRARY_NOT_FOUND', 'Library not found');
    }

    const page = await this.scanRuns.listForLibrary(libraryId, query);
    return { items: page.items.map(toScanRunDto), nextCursor: page.nextCursor };
  }
}

export function toScanRunDto(run: ScanRun): ScanRunDto {
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    filesSeen: run.filesSeen,
    filesNew: run.filesNew,
    filesChanged: run.filesChanged,
    filesMissing: run.filesMissing,
    error: run.error,
  };
}
