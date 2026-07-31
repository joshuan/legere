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

// Internal signal, never leaves this file: the only way to undo the ScanRun insert is to roll the
// transaction back.
class ScanAlreadyQueued extends Error {}

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

    return this.unitOfWork
      .run<TriggerScanResponse>(async (tx) => {
        // startRun returns null when the scan_runs_running_uq index refuses a second RUNNING row —
        // the database decides, so two simultaneous clicks cannot both start a scan (docs/04 §4.3).
        const run = await this.scanRuns.startRun(library.id, tx);
        if (run === null) return { alreadyRunning: true };

        const jobId = await this.queue.enqueueAfterTx(
          tx,
          'library-scan',
          { libraryId: library.id, scanRunId: run.id },
          { singletonKey: library.id, priority: USER_PRIORITY },
        );

        // The queue already holds a scan for this library (the periodic sweep got there first), so
        // this send collapsed into it. Rolling the run back matters: a RUNNING row with no job
        // behind it would sit in the journal forever and, through scan_runs_running_uq, block every
        // later scan of the library.
        if (jobId === null) throw new ScanAlreadyQueued();
        return { scanRunId: run.id };
      })
      .catch((error: unknown) => {
        if (error instanceof ScanAlreadyQueued) return { alreadyRunning: true };
        throw error;
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
