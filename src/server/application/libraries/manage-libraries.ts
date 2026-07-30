import type {
  CreateLibraryRequest,
  LibraryAdminDto,
  LibraryAdminListItem,
  ListLibrariesAdminResponse,
  ListLibrariesResponse,
  PathCandidatesResponse,
  UpdateLibraryRequest,
} from '../../../shared/contracts/libraries';
import { pathsOverlap, SCAN_SWEEP_CRON, type Library } from '../../domain/entities/library';
import { ConflictError, NotFoundError, UnprocessableError } from '../../domain/errors/domain-error';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import type { ScanRunRepository } from '../../domain/repositories/scan-run.repository';
import { RelativePath } from '../../domain/value-objects/relative-path';
import type { Clock } from '../ports/clock';
import type { JobQueue } from '../ports/job-queue';
import type { LibraryReader } from '../ports/library-reader';
import type { UnitOfWork } from '../ports/unit-of-work';

// A user-triggered scan outranks background work (docs/05 §5.4).
const USER_PRIORITY = 10;

// POST /api/admin/libraries (docs/07 §7.3). Validates the path against the volume, rejects overlap
// with an existing library, then — in one transaction — writes the library, its ACL and the first
// scan job, and registers the recurring scan.
export class CreateLibrary {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(input: CreateLibraryRequest): Promise<LibraryAdminDto> {
    const rootPath = parseRootPath(input.rootPath);

    // 🔒 Must be an existing directory inside LIBRARY_ROOT (docs/03 §3.3.6). A file, a missing path
    // or anything the reader refuses to resolve fails the same way.
    if (!(await this.reader.isDirectory(rootPath))) {
      throw new UnprocessableError(
        'LIBRARY_PATH_INVALID',
        'The path is not an existing directory inside the library volume',
      );
    }

    const library = await this.unitOfWork.run(async (tx) => {
      await assertNoOverlap(this.libraries, rootPath, null, tx);

      const created = await this.libraries.create(
        {
          name: input.name,
          rootPath,
          visibility: input.visibility,
          scanIntervalMinutes: input.scanIntervalMinutes,
          excludeGlobs: input.excludeGlobs,
        },
        tx,
      );
      await this.libraries.replaceUserIds(created.id, input.userIds, tx);

      // The first scan commits with the library: a library that exists is always one that will be
      // scanned (docs/05 §5.2, docs/06 §6.3.4).
      await this.queue.enqueueAfterTx(
        tx,
        'library-scan',
        { libraryId: created.id },
        { singletonKey: created.id, priority: USER_PRIORITY },
      );

      return created;
    });

    // A single sweep schedule for every library (see isScanDue): registering it again is an upsert,
    // so creating more libraries does not multiply schedules.
    await this.queue.scheduleCron('library-scan', SCAN_SWEEP_CRON, {});

    return toLibraryAdminDto(library, input.userIds);
  }
}

// PATCH /api/admin/libraries/:id. rootPath is immutable — the contract has no field for it — so the
// overlap rule cannot be violated by an update.
export class UpdateLibrary {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(id: string, input: UpdateLibraryRequest): Promise<LibraryAdminDto> {
    const { library, userIds } = await this.unitOfWork.run(async (tx) => {
      const existing = await requireLibrary(this.libraries, id, tx);

      const updated = await this.libraries.update(
        existing.id,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
          ...(input.scanIntervalMinutes === undefined
            ? {}
            : { scanIntervalMinutes: input.scanIntervalMinutes }),
          ...(input.excludeGlobs === undefined ? {} : { excludeGlobs: input.excludeGlobs }),
        },
        tx,
      );

      if (input.userIds !== undefined) {
        await this.libraries.replaceUserIds(existing.id, input.userIds, tx);
      }
      const currentUserIds = await this.libraries.listUserIds(existing.id, tx);
      return { library: updated, userIds: currentUserIds };
    });

    // The sweep decides per library whether a scan is due, so an interval change needs no schedule
    // change; the schedule only has to exist while at least one library could be scanned.
    await this.syncSweepSchedule();

    return toLibraryAdminDto(library, userIds);
  }

  private syncSweepSchedule(): Promise<void> {
    return syncSweepSchedule(this.libraries, this.queue);
  }
}

// DELETE /api/admin/libraries/:id — soft delete (ADR-015): content leaves every listing, FileRefs
// and documents are retained.
export class DeleteLibrary {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
  ) {}

  async execute(id: string): Promise<void> {
    const library = await requireLibrary(this.libraries, id);
    await this.libraries.softDelete(library.id, this.clock.now());
    await syncSweepSchedule(this.libraries, this.queue);
  }
}

// GET /api/admin/libraries — every active library with its counters and last scan.
export class ListLibrariesAdmin {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly scanRuns: ScanRunRepository,
  ) {}

  async execute(): Promise<ListLibrariesAdminResponse> {
    const libraries = await this.libraries.listActive();
    const ids = libraries.map((library) => library.id);

    const [counts, latest] = await Promise.all([
      this.libraries.countsFor(ids),
      this.scanRuns.latestForLibraries(ids),
    ]);
    const countsById = new Map(counts.map((entry) => [entry.libraryId, entry]));

    const items: LibraryAdminListItem[] = [];
    for (const library of libraries) {
      const userIds = await this.libraries.listUserIds(library.id);
      const counters = countsById.get(library.id);
      const lastRun = latest.get(library.id);

      items.push({
        ...toLibraryAdminDto(library, userIds),
        counters: {
          files: counters?.files ?? 0,
          documents: counters?.documents ?? 0,
          missing: counters?.missing ?? 0,
        },
        lastScan:
          lastRun === undefined
            ? null
            : {
                startedAt: lastRun.startedAt.toISOString(),
                finishedAt: lastRun.finishedAt?.toISOString() ?? null,
                status: lastRun.status,
              },
      });
    }

    return { items };
  }
}

// GET /api/admin/libraries/:id
export class GetLibraryAdmin {
  constructor(private readonly libraries: LibraryRepository) {}

  async execute(id: string): Promise<LibraryAdminDto> {
    const library = await requireLibrary(this.libraries, id);
    return toLibraryAdminDto(library, await this.libraries.listUserIds(library.id));
  }
}

// GET /api/libraries — only what the caller may read (docs/08 §8.5). Admins see every active library.
export class ListVisibleLibraries {
  constructor(private readonly libraries: LibraryRepository) {}

  async execute(user: { id: string; role: 'ADMIN' | 'USER' }): Promise<ListLibrariesResponse> {
    const libraries =
      user.role === 'ADMIN'
        ? await this.libraries.listActive()
        : await this.libraries.listVisibleTo(user.id);

    return { items: libraries.map((library) => ({ id: library.id, name: library.name })) };
  }
}

// GET /api/admin/library-path-candidates?path= — a directory browser confined to LIBRARY_ROOT
// (docs/07 §7.3). Never lists anything outside the volume: RelativePath rejects traversal and the
// reader re-checks the resolved path.
export class ListLibraryPathCandidates {
  constructor(private readonly reader: LibraryReader) {}

  async execute(rawPath: string): Promise<PathCandidatesResponse> {
    const path = parseRootPath(rawPath);
    if (!(await this.reader.isDirectory(path))) {
      throw new UnprocessableError('LIBRARY_PATH_INVALID', 'The path is not a directory');
    }

    const entries = await this.reader.list(
      { rootPath: RelativePath.root(), excludeGlobs: [] },
      path,
    );
    return {
      path: path.value,
      dirs: entries.filter((entry) => entry.isDirectory).map((entry) => ({ name: entry.name })),
    };
  }
}

function parseRootPath(raw: string): RelativePath {
  const path = RelativePath.tryParse(raw);
  if (path === null) {
    throw new UnprocessableError(
      'LIBRARY_PATH_INVALID',
      'The path is not inside the library volume',
    );
  }
  return path;
}

async function requireLibrary(
  libraries: LibraryRepository,
  id: string,
  tx?: unknown,
): Promise<Library> {
  const library = await libraries.findById(id, tx);
  if (library === null || library.deletedAt !== null) {
    throw new NotFoundError('LIBRARY_NOT_FOUND', 'Library not found');
  }
  return library;
}

// 🔒 No two active libraries may nest or duplicate (docs/03 §3.3.6). Checked inside the caller's
// transaction so two concurrent creates cannot both pass.
async function assertNoOverlap(
  libraries: LibraryRepository,
  rootPath: RelativePath,
  ignoreId: string | null,
  tx: unknown,
): Promise<void> {
  const active = await libraries.listActive(tx);
  const clash = active.find(
    (library) => library.id !== ignoreId && pathsOverlap(library.rootPath, rootPath),
  );
  if (clash !== undefined) {
    throw new ConflictError(
      'LIBRARY_PATH_CONFLICT',
      'This path overlaps the library "' + clash.name + '"',
    );
  }
}

// Keeps the single sweep schedule in step with reality: present while any enabled library exists,
// absent otherwise, so an instance with nothing to scan runs no cron at all.
async function syncSweepSchedule(libraries: LibraryRepository, queue: JobQueue): Promise<void> {
  const active = await libraries.listActive();
  if (active.some((library) => library.enabled)) {
    await queue.scheduleCron('library-scan', SCAN_SWEEP_CRON, {});
  } else {
    await queue.unscheduleCron('library-scan');
  }
}

export function toLibraryAdminDto(library: Library, userIds: string[]): LibraryAdminDto {
  return {
    id: library.id,
    name: library.name,
    rootPath: library.rootPath.value,
    enabled: library.enabled,
    visibility: library.visibility,
    scanIntervalMinutes: library.scanIntervalMinutes,
    excludeGlobs: library.excludeGlobs,
    userIds,
    createdAt: library.createdAt.toISOString(),
  };
}
