import { z } from 'zod';
import { isScanDue } from '../../domain/entities/library';
import { needsRehash } from '../../domain/entities/file-ref';
import type {
  FileRefRepository,
  FileRefSnapshot,
} from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import type { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import type { Clock } from '../ports/clock';
import type { JobQueue } from '../ports/job-queue';
import type { LibraryReader } from '../ports/library-reader';
import { JobHandler } from './job-handler';

// Payload validation lives with the consumer (docs/14 §14.7). An empty payload is the cron sweep;
// a payload with a libraryId scans that one library.
export const libraryScanPayloadSchema = z.object({
  libraryId: z.string().uuid().optional(),
  scanRunId: z.string().uuid().optional(),
});
export type LibraryScanPayload = z.infer<typeof libraryScanPayloadSchema>;

// ScanRun.error holds at most this much text, so one unreadable tree cannot bloat the journal.
const MAX_ERROR_LENGTH = 2000;

// Raised when a library turns out to hold more files than the instance is willing to take in one
// pass. Terminal by nature: retrying walks the same enormous tree again, so the handler records it
// and returns instead of rethrowing into the queue's backoff.
class ScanTooLargeError extends Error {}

// `library-scan` (docs/05 §5.2). Walks the volume, compares path + size + mtime against the known
// FileRefs, and enqueues `file-ingest` only for what is new or changed.
//
// Idempotent (docs/05 §5.4): a re-delivered job whose ScanRun has already finished returns
// immediately, and the diff itself is convergent — running it twice over an unchanged tree performs
// no writes and enqueues nothing.
export class HandleLibraryScan extends JobHandler {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly scanRuns: ScanRunRepository,
    private readonly reader: LibraryReader,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
    // SCAN_MAX_FILES; 0 means the operator has taken the brakes off deliberately (docs/12 §12.4).
    private readonly maxFiles: number,
  ) {
    super();
  }

  async handle(rawPayload: unknown): Promise<void> {
    const payload = libraryScanPayloadSchema.parse(rawPayload);
    if (payload.libraryId === undefined) {
      await this.sweepDueLibraries();
      return;
    }
    await this.scanLibrary(payload.libraryId, payload.scanRunId ?? null);
  }

  // The cron sweep: one schedule serves every library, because pg-boss keys schedules by queue name
  // (see isScanDue). Each due library gets its own singleton-keyed job, so a library already being
  // scanned is simply skipped by the queue.
  private async sweepDueLibraries(): Promise<void> {
    const libraries = await this.libraries.listActive();
    if (libraries.length === 0) return;

    const latest = await this.scanRuns.latestForLibraries(libraries.map((library) => library.id));
    const now = this.clock.now();

    for (const library of libraries) {
      const lastRun = latest.get(library.id);
      if (!isScanDue(library, lastRun?.startedAt ?? null, now)) continue;

      await this.queue.enqueue(
        'library-scan',
        { libraryId: library.id },
        { singletonKey: library.id },
      );
    }
  }

  private async scanLibrary(libraryId: string, existingRunId: string | null): Promise<void> {
    const library = await this.libraries.findById(libraryId);
    // A library deleted or disabled between enqueue and delivery is simply not scanned.
    if (library === null || library.deletedAt !== null || !library.enabled) return;

    const run = await this.resolveRun(libraryId, existingRunId);
    if (run === null) return;

    const startedAt = this.clock.now();
    const known = await this.fileRefs.snapshotForLibrary(libraryId);
    const byPath = new Map(known.map((ref) => [ref.path, ref]));

    let filesSeen = 0;
    let filesNew = 0;
    let filesChanged = 0;
    const unchangedIds: string[] = [];
    const seenPaths = new Set<string>();
    const toIngest: string[] = [];

    const walk = this.reader.walk({
      rootPath: library.rootPath,
      excludeGlobs: library.excludeGlobs,
    });

    try {
      for await (const entry of walk.entries) {
        filesSeen += 1;
        if (this.maxFiles > 0 && filesSeen > this.maxFiles) {
          throw new ScanTooLargeError(
            `Stopped after ${this.maxFiles} files: this library covers a larger tree than ` +
              'SCAN_MAX_FILES allows. Point it at a narrower folder, or raise SCAN_MAX_FILES.',
          );
        }
        seenPaths.add(entry.relPath.value);

        const existing = byPath.get(entry.relPath.value);
        if (existing === undefined) {
          const created = await this.fileRefs.create({
            libraryId,
            path: entry.relPath,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            seenAt: startedAt,
          });
          filesNew += 1;
          toIngest.push(created.id);
          continue;
        }

        if (needsRehash(toFileRef(existing), entry.size, entry.mtimeMs)) {
          // Covers three cases at once: content moved, the file returned from MISSING, and a ref that
          // never finished ingesting. All three need the bytes read again.
          await this.fileRefs.markDiscovered(
            existing.id,
            entry.size,
            entry.mtimeMs,
            startedAt,
            undefined,
          );
          filesChanged += 1;
          toIngest.push(existing.id);
          continue;
        }

        unchangedIds.push(existing.id);
      }

      if (unchangedIds.length > 0) {
        await this.fileRefs.touchSeen(unchangedIds, startedAt);
      }

      // Anything known but not seen this pass has gone from disk (docs/05 §5.7). Refs already MISSING
      // are left alone so missingSince keeps its original value; refs EXCLUDED are left alone
      // because they are a tombstone and not a file — "the deleted document's original has moved
      // away" is not news about availability, and a tombstone a moved folder can clear would let the
      // document back in when the file returned (docs/03 §3.3.9).
      const vanished = known
        .filter(
          (ref) =>
            ref.status !== 'MISSING' && ref.status !== 'EXCLUDED' && !seenPaths.has(ref.path),
        )
        .map((ref) => ref.id);
      const filesMissing =
        vanished.length === 0 ? 0 : await this.fileRefs.markMissing(vanished, startedAt);

      // Only once the whole tree is known: a scan that gives up halfway must not leave tens of
      // thousands of ingest jobs behind it.
      for (const fileRefId of toIngest) {
        await this.queue.enqueue('file-ingest', { fileRefId });
      }

      await this.scanRuns.finish(
        run.id,
        'DONE',
        { filesSeen, filesNew, filesChanged, filesMissing },
        this.clock.now(),
        formatWalkErrors(walk.errors),
      );
    } catch (error) {
      await this.scanRuns.finish(
        run.id,
        'FAILED',
        { filesSeen, filesNew, filesChanged, filesMissing: 0 },
        this.clock.now(),
        truncate(error instanceof Error ? error.message : String(error)),
      );
      // Anything else deserves the queue's retry; being too large does not — the tree will be just
      // as large in thirty seconds, and five more passes only cost the operator time.
      if (error instanceof ScanTooLargeError) return;
      throw error;
    }
  }

  // Reuses the run the API created for "Scan now"; otherwise starts one. Returns null when the run
  // is already finished (a re-delivered job) or when another scan holds the RUNNING slot.
  private async resolveRun(
    libraryId: string,
    existingRunId: string | null,
  ): Promise<{ id: string } | null> {
    if (existingRunId !== null) {
      const run = await this.scanRuns.findById(existingRunId);
      if (run === null || run.status !== 'RUNNING') return null;
      return { id: run.id };
    }

    const started = await this.scanRuns.startRun(libraryId);
    if (started !== null) return started;

    // scan_runs_running_uq refused: a RUNNING row is already there, left behind by a process that
    // died mid-scan or by a "Scan now" whose job the queue collapsed. Adopting it heals the library
    // instead of blocking it forever — the queue guarantees only one scan job per library runs at a
    // time, so there is no second worker to collide with (docs/05 §5.2).
    return this.scanRuns.findRunning(libraryId);
  }
}

// Unreadable directories are reported, not fatal (docs/09 §9.1): the scan still completes DONE and the
// journal records what could not be read.
function formatWalkErrors(errors: { relPath: string; message: string }[]): string | null {
  if (errors.length === 0) return null;
  const lines = errors.map((error) => `${error.relPath}: ${error.message}`);
  return truncate(
    `Could not read ${errors.length} director${errors.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`,
  );
}

function truncate(text: string): string {
  return text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

// The diff only needs the comparable fields; the rest of a FileRef is irrelevant to needsRehash.
function toFileRef(snapshot: FileRefSnapshot) {
  return {
    id: snapshot.id,
    libraryId: '',
    path: RelativePath.tryParse(snapshot.path) ?? RelativePath.root(),
    size: snapshot.size,
    mtimeMs: snapshot.mtimeMs,
    status: snapshot.status,
    contentHash: snapshot.contentHash,
    fileId: snapshot.fileId,
    missingSince: null,
    firstSeenAt: new Date(0),
    lastSeenAt: new Date(0),
  };
}
