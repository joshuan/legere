import type { ScanRunStatus } from '../../../shared/contracts/enums';
import type { TransactionHandle } from '../../application/ports/unit-of-work';

// ScanRun entity (docs/03 §3.3.8): the journal of library scans.
export type ScanRun = {
  id: string;
  libraryId: string;
  status: ScanRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  filesSeen: number;
  filesNew: number;
  filesChanged: number;
  filesMissing: number;
  error: string | null;
};

export type ScanRunCounters = {
  filesSeen: number;
  filesNew: number;
  filesChanged: number;
  filesMissing: number;
};

export type ScanRunPage = {
  items: ScanRun[];
  nextCursor: string | null;
};

export abstract class ScanRunRepository {
  // Returns null when a RUNNING scan already exists for the library: the partial unique index
  // scan_runs_running_uq (docs/04 §4.3) makes that the database's decision, not a read-then-write.
  abstract startRun(libraryId: string, tx?: TransactionHandle): Promise<ScanRun | null>;

  abstract findRunning(libraryId: string, tx?: TransactionHandle): Promise<ScanRun | null>;

  abstract findById(id: string, tx?: TransactionHandle): Promise<ScanRun | null>;

  abstract finish(
    id: string,
    status: Extract<ScanRunStatus, 'DONE' | 'FAILED'>,
    counters: ScanRunCounters,
    finishedAt: Date,
    error: string | null,
    tx?: TransactionHandle,
  ): Promise<void>;

  // Newest first (docs/07 §7.3).
  abstract listForLibrary(
    libraryId: string,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<ScanRunPage>;

  // Feeds the admin table's "last scan" column (docs/11 §11.10).
  abstract latestForLibraries(
    libraryIds: string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, ScanRun>>;
}
