import type { LibraryVisibility } from '../../../shared/contracts/enums';
import type { RelativePath } from '../value-objects/relative-path';

// Library entity (docs/03 §3.3.6).
export type Library = {
  id: string;
  name: string;
  rootPath: RelativePath;
  enabled: boolean;
  visibility: LibraryVisibility;
  scanIntervalMinutes: number;
  excludeGlobs: string[];
  createdAt: Date;
  deletedAt: Date | null;
};

// 🔒 Active libraries must not nest (docs/03 §3.3.6): a file must belong to at most one library, so a
// new rootPath may be neither an ancestor nor a descendant of an existing one — and the volume root
// ('') is an ancestor of everything, which this comparison handles naturally.
export function pathsOverlap(a: RelativePath, b: RelativePath): boolean {
  if (a.isRoot || b.isRoot) return true;
  if (a.equals(b)) return true;
  return isDescendantOf(a, b) || isDescendantOf(b, a);
}

// True when `candidate` sits under `ancestor`. Segment-wise so 'invoices2' is not read as a child of
// 'invoices'.
function isDescendantOf(candidate: RelativePath, ancestor: RelativePath): boolean {
  const candidateSegments = candidate.segments;
  const ancestorSegments = ancestor.segments;
  if (candidateSegments.length <= ancestorSegments.length) return false;
  return ancestorSegments.every((segment, index) => candidateSegments[index] === segment);
}

// Visibility (docs/08 §8.5): ALL_USERS is open to every active user, RESTRICTED needs a grant. An
// admin sees everything, which callers handle before consulting this.
export function isLibraryVisibleTo(
  library: Library,
  grantedLibraryIds: ReadonlySet<string>,
): boolean {
  if (library.deletedAt !== null) return false;
  if (library.visibility === 'ALL_USERS') return true;
  return grantedLibraryIds.has(library.id);
}

// Whether a library is due for its next scan (docs/03 §3.3.6, docs/05 §5.2).
//
// pg-boss keys schedules by queue name alone (PRIMARY KEY (name) on pgboss.schedule), so there can
// be exactly one cron row for `library-scan` — per-library cron entries, as docs/06 §6.8 describes
// them, are not expressible. Instead a single sweep runs every minute and asks this predicate which
// libraries are due, which honours each library's own interval exactly.
export function isScanDue(
  library: Pick<Library, 'enabled' | 'scanIntervalMinutes' | 'deletedAt'>,
  lastScanStartedAt: Date | null,
  now: Date,
): boolean {
  if (!library.enabled || library.deletedAt !== null) return false;
  // Never scanned: due immediately.
  if (lastScanStartedAt === null) return true;

  const intervalMs = Math.max(1, Math.floor(library.scanIntervalMinutes)) * 60_000;
  return now.getTime() - lastScanStartedAt.getTime() >= intervalMs;
}

// The one cron expression backing that sweep. A minute is the smallest configurable interval
// (docs/03 §3.3.6), so checking every minute is the coarsest schedule that can still honour it.
export const SCAN_SWEEP_CRON = '* * * * *';
