import { mkdtemp, mkdir, rm, rename, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HandleFileIngest } from '../../src/server/application/jobs/handle-file-ingest';
import { HandleLibraryScan } from '../../src/server/application/jobs/handle-library-scan';
import { TriggerScan } from '../../src/server/application/libraries/manage-scans';
import { Clock } from '../../src/server/application/ports/clock';
import { JobQueue } from '../../src/server/application/ports/job-queue';
import { LibraryReader } from '../../src/server/application/ports/library-reader';
import { UnitOfWork } from '../../src/server/application/ports/unit-of-work';
import { FileRefRepository } from '../../src/server/domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../src/server/domain/repositories/library.repository';
import { ScanRunRepository } from '../../src/server/domain/repositories/scan-run.repository';
import { AuthInfrastructureModule } from '../../src/server/infrastructure/auth/auth-infrastructure.module';
import { AppConfig, loadConfig } from '../../src/server/infrastructure/config/app-config';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { AiModule } from '../../src/server/infrastructure/ai/ai.module';
import { PdfModule } from '../../src/server/infrastructure/pdf/pdf.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { PgBossProvider } from '../../src/server/infrastructure/queue/pg-boss.provider';
import { StorageModule } from '../../src/server/infrastructure/storage/storage.module';
import { QueueModule } from '../../src/server/infrastructure/queue/queue.module';
import { JobsModule } from '../../src/server/presentation/jobs/jobs.module';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';

// The core promise of the product (docs/05 §5.2–5.4, §5.7, docs/03 §3.3.9–3.3.10): a mounted folder
// becomes deduplicated documents. Exercised over real files with the real database and queue.
// chmod 000 means nothing to root: the directory stays readable, and the two tests below would fail
// for a reason that is not about the code. CI runs as an ordinary user; a root container (or a
// devcontainer) skips them instead of reporting a false failure.
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

describe('Scan and ingest (integration)', () => {
  let root: string;
  let prisma: PrismaService;
  let queue: JobQueue;
  let scan: HandleLibraryScan;
  let ingest: HandleFileIngest;
  let triggerScan: TriggerScan;
  let moduleRef: TestingModule;
  let close: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'legere-scan-'));

    moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }),
        ConfigModule,
        // Provides Clock, which the scan handler uses for run timing (global in AppModule).
        AuthInfrastructureModule,
        PersistenceModule,
        StorageModule,
        PdfModule,
        AiModule,
        QueueModule,
        JobsModule,
      ],
    })
      .overrideProvider(AppConfig)
      .useValue(
        loadConfig({
          ...process.env,
          LIBRARY_ROOT: root,
          LOG_LEVEL: 'silent',
        }),
      )
      .compile();

    prisma = moduleRef.get(PrismaService);
    queue = moduleRef.get(JobQueue);
    scan = moduleRef.get(HandleLibraryScan);
    ingest = moduleRef.get(HandleFileIngest);
    // The "Scan now" use case over the same real repositories and queue (docs/07 §7.3).
    triggerScan = new TriggerScan(
      moduleRef.get(LibraryRepository),
      moduleRef.get(ScanRunRepository),
      moduleRef.get(JobQueue),
      moduleRef.get(UnitOfWork),
    );
    close = () => moduleRef.close();

    await moduleRef.get(PgBossProvider).start();
  });

  beforeEach(async () => {
    await truncateAll();
    await prisma.$executeRawUnsafe('DELETE FROM pgboss.job');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    if (close !== null) await close();
    await disconnectTestPrisma();
  });

  // Helpers -----------------------------------------------------------------

  async function createLibrary(excludeGlobs: string[] = [], rootPath = ''): Promise<string> {
    const library = await prisma.library.create({
      data: {
        name: `Fixtures ${rootPath === '' ? 'root' : rootPath}`,
        rootPath,
        visibility: 'ALL_USERS',
        excludeGlobs,
        scanIntervalMinutes: 15,
      },
    });
    return library.id;
  }

  async function writeFixture(relPath: string, contents: string): Promise<void> {
    const absolute = join(root, relPath);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents);
  }

  // Drains the file-ingest queue the way the worker would, one job at a time.
  async function runIngests(): Promise<number> {
    const jobs = await prisma.$queryRawUnsafe<{ data: { fileRefId: string } }[]>(
      "SELECT data FROM pgboss.job WHERE name = 'file-ingest' AND state = 'created'",
    );
    for (const job of jobs) {
      await ingest.handle(job.data);
    }
    await prisma.$executeRawUnsafe("DELETE FROM pgboss.job WHERE name = 'file-ingest'");
    return jobs.length;
  }

  const queuedIngests = (): Promise<{ count: bigint }[]> =>
    prisma.$queryRawUnsafe("SELECT count(*) AS count FROM pgboss.job WHERE name = 'file-ingest'");

  const countProcessJobs = async (): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*) AS count FROM pgboss.job WHERE name = 'document-process'",
    );
    return Number(rows[0]?.count ?? 0n);
  };

  const refs = (libraryId: string) =>
    prisma.fileRef.findMany({ where: { libraryId }, orderBy: { path: 'asc' } });

  const latestRun = (libraryId: string) =>
    prisma.scanRun.findFirstOrThrow({ where: { libraryId }, orderBy: { startedAt: 'desc' } });

  // Tests -------------------------------------------------------------------

  describe('the scan diff (docs/05 §5.2)', () => {
    it('discovers new files, records a ScanRun and enqueues one ingest each', async () => {
      const libraryId = await createLibrary();
      await writeFixture('top.txt', 'top');
      await writeFixture('nested/deep/inner.txt', 'inner');

      await scan.handle({ libraryId });

      const found = await refs(libraryId);
      expect(found.map((ref) => ref.path)).toEqual(['nested/deep/inner.txt', 'top.txt']);
      expect(found.every((ref) => ref.status === 'DISCOVERED')).toBe(true);

      const run = await latestRun(libraryId);
      expect(run).toMatchObject({
        status: 'DONE',
        filesSeen: 2,
        filesNew: 2,
        filesChanged: 0,
        filesMissing: 0,
        error: null,
      });
      expect(run.finishedAt).not.toBeNull();

      const [queued] = await queuedIngests();
      expect(Number(queued?.count ?? 0n)).toBe(2);
    });

    it('enqueues nothing on a rescan with no changes', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'a');
      await scan.handle({ libraryId });
      await runIngests();

      await scan.handle({ libraryId });

      const [queued] = await queuedIngests();
      expect(Number(queued?.count ?? 0n)).toBe(0);
      const run = await latestRun(libraryId);
      expect(run).toMatchObject({ filesSeen: 1, filesNew: 0, filesChanged: 0, filesMissing: 0 });
    });

    it('re-ingests a file whose size or mtime moved', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'a');
      await scan.handle({ libraryId });
      await runIngests();

      await writeFixture('a.txt', 'a much longer body');
      await scan.handle({ libraryId });

      const [ref] = await refs(libraryId);
      expect(ref?.status).toBe('DISCOVERED');
      const [queued] = await queuedIngests();
      expect(Number(queued?.count ?? 0n)).toBe(1);
      expect(await latestRun(libraryId)).toMatchObject({ filesChanged: 1, filesNew: 0 });
    });

    it('notices a touched file even when its size is unchanged', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'same');
      await scan.handle({ libraryId });
      await runIngests();

      const future = new Date(Date.now() + 60_000);
      await utimes(join(root, 'a.txt'), future, future);
      await scan.handle({ libraryId });

      expect(await latestRun(libraryId)).toMatchObject({ filesChanged: 1 });
    });

    it('marks a vanished file MISSING without deleting anything', async () => {
      const libraryId = await createLibrary();
      await writeFixture('gone.txt', 'gone');
      await scan.handle({ libraryId });
      await runIngests();
      const documentsBefore = await prisma.document.count();

      await rm(join(root, 'gone.txt'));
      await scan.handle({ libraryId });

      const [ref] = await refs(libraryId);
      expect(ref?.status).toBe('MISSING');
      expect(ref?.missingSince).not.toBeNull();
      // 🔒 The document survives (docs/05 §5.7).
      expect(await prisma.document.count()).toBe(documentsBefore);
      expect(await latestRun(libraryId)).toMatchObject({ filesMissing: 1, filesSeen: 0 });
    });

    it('keeps the original missingSince across further scans', async () => {
      const libraryId = await createLibrary();
      await writeFixture('gone.txt', 'gone');
      await scan.handle({ libraryId });
      await runIngests();
      await rm(join(root, 'gone.txt'));

      await scan.handle({ libraryId });
      const first = (await refs(libraryId))[0]?.missingSince;
      await scan.handle({ libraryId });
      const second = (await refs(libraryId))[0]?.missingSince;

      expect(second?.getTime()).toBe(first?.getTime());
      // Already-missing refs are not recounted.
      expect(await latestRun(libraryId)).toMatchObject({ filesMissing: 0 });
    });

    it('honours excludeGlobs and skips hidden entries', async () => {
      const libraryId = await createLibrary(['**/skip/**']);
      await writeFixture('keep.txt', 'keep');
      await writeFixture('skip/ignored.txt', 'ignored');
      await writeFixture('.hidden.txt', 'hidden');

      await scan.handle({ libraryId });

      expect((await refs(libraryId)).map((ref) => ref.path)).toEqual(['keep.txt']);
    });

    it('does not scan a disabled or soft-deleted library', async () => {
      const disabled = await createLibrary();
      await prisma.library.update({ where: { id: disabled }, data: { enabled: false } });
      await writeFixture('a.txt', 'a');

      await scan.handle({ libraryId: disabled });
      expect(await refs(disabled)).toHaveLength(0);
      expect(await prisma.scanRun.count()).toBe(0);
    });

    it('gives up on a tree larger than SCAN_MAX_FILES rather than ingesting a whole disk', async () => {
      const libraryId = await createLibrary();
      await writeFixture('one.txt', '1');
      await writeFixture('two.txt', '2');
      await writeFixture('three.txt', '3');

      // The same handler the container builds, with the limit an operator would set (docs/05 §5.2).
      const capped = new HandleLibraryScan(
        moduleRef.get(LibraryRepository),
        moduleRef.get(FileRefRepository),
        moduleRef.get(ScanRunRepository),
        moduleRef.get(LibraryReader),
        moduleRef.get(JobQueue),
        moduleRef.get(Clock),
        2,
      );

      await capped.handle({ libraryId });

      const run = await latestRun(libraryId);
      expect(run.status).toBe('FAILED');
      // The message has to say what to change; the number alone helps nobody.
      expect(run.error).toContain('SCAN_MAX_FILES');
      // 🔒 The point of the guard: nothing downstream was scheduled.
      const queued = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        "SELECT count(*) FROM pgboss.job WHERE name = 'file-ingest'",
      );
      expect(Number(queued[0]?.count ?? 0)).toBe(0);
    });

    it('takes the same tree once the limit allows it', async () => {
      const libraryId = await createLibrary();
      await writeFixture('one.txt', '1');
      await writeFixture('two.txt', '2');

      await scan.handle({ libraryId });

      // The refs the capped pass left behind are ordinary DISCOVERED refs; a scan with room simply
      // ingests them.
      expect((await latestRun(libraryId)).status).toBe('DONE');
      expect(await refs(libraryId)).toHaveLength(2);
    });

    it('is idempotent under double delivery', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'a');

      await scan.handle({ libraryId });
      await scan.handle({ libraryId });

      // The same file is still one ref, and the second pass saw no changes.
      expect(await refs(libraryId)).toHaveLength(1);
      const runs = await prisma.scanRun.findMany({ where: { libraryId } });
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.status === 'DONE')).toBe(true);
    });

    it('reuses the ScanRun the API created and ignores a re-delivered finished run', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'a');
      const run = await prisma.scanRun.create({ data: { libraryId, status: 'RUNNING' } });

      await scan.handle({ libraryId, scanRunId: run.id });
      expect(await prisma.scanRun.count()).toBe(1);
      expect((await latestRun(libraryId)).status).toBe('DONE');

      // Re-delivery of a finished run does nothing at all.
      await scan.handle({ libraryId, scanRunId: run.id });
      expect(await prisma.scanRun.count()).toBe(1);
    });

    it('records an unreadable directory in the journal without failing the scan', async (ctx) => {
      if (RUNNING_AS_ROOT) ctx.skip('running as root — permission bits do not apply');
      const libraryId = await createLibrary();
      await writeFixture('readable.txt', 'ok');
      const locked = join(root, 'locked');
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, 'inner.txt'), 'x');
      const { chmod } = await import('node:fs/promises');
      await chmod(locked, 0o000);

      try {
        await scan.handle({ libraryId });

        const run = await latestRun(libraryId);
        expect(run.status).toBe('DONE');
        expect(run.error).toContain('locked');
        expect((await refs(libraryId)).map((ref) => ref.path)).toEqual(['readable.txt']);
      } finally {
        await chmod(locked, 0o755);
      }
    });
  });

  describe('the cron sweep', () => {
    it('enqueues a scan for a library that has never been scanned', async () => {
      const libraryId = await createLibrary();

      await scan.handle({});

      const jobs = await prisma.$queryRawUnsafe<{ data: { libraryId: string } }[]>(
        "SELECT data FROM pgboss.job WHERE name = 'library-scan'",
      );
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.data).toEqual({ libraryId });
    });

    it('skips a library scanned within its interval and includes one past it', async () => {
      await mkdir(join(root, 'stale'), { recursive: true });
      const fresh = await createLibrary();
      const stale = await createLibrary([], 'stale');

      await prisma.scanRun.create({
        data: { libraryId: fresh, status: 'DONE', startedAt: new Date(), finishedAt: new Date() },
      });
      await prisma.scanRun.create({
        data: {
          libraryId: stale,
          status: 'DONE',
          startedAt: new Date(Date.now() - 60 * 60_000),
          finishedAt: new Date(),
        },
      });

      await scan.handle({});

      const jobs = await prisma.$queryRawUnsafe<{ data: { libraryId: string } }[]>(
        "SELECT data FROM pgboss.job WHERE name = 'library-scan'",
      );
      expect(jobs.map((job) => job.data.libraryId)).toEqual([stale]);
    });
  });

  describe('ingest and deduplication (docs/05 §5.3, ADR-009)', () => {
    it('hashes a file, creates a document and starts the pipeline once', async () => {
      const libraryId = await createLibrary();
      await writeFixture('report.txt', 'hello world');
      await scan.handle({ libraryId });
      await runIngests();

      const [ref] = await refs(libraryId);
      expect(ref?.status).toBe('HASHED');
      expect(ref?.contentHash).toMatch(/^[0-9a-f]{64}$/);
      // A ref points at the file its bytes are, and the file is what a document holds (ADR-021).
      expect(ref?.fileId).not.toBeNull();

      const document = await prisma.document.findFirstOrThrow();
      expect(document).toMatchObject({
        // Title comes from the file name without its extension (docs/03 §3.3.10).
        title: 'report',
        // A document row is only ever created together with a job for it, so its steps start in the
        // queue rather than unscheduled (docs/03 §3.3.10).
        canonicalStatus: 'QUEUED',
      });

      const file = await prisma.file.findFirstOrThrow();
      expect(file).toMatchObject({
        origin: 'LIBRARY',
        // A library file's bytes stay on the volume: no object of our own (docs/09 §9.2).
        storageKey: null,
        mimeType: 'text/plain',
        ext: 'txt',
        sizeBytes: 11n,
        name: 'report.txt',
      });
      // sha256('hello world')
      expect(file.contentHash).toBe(
        'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
      );
      // And the document holds exactly it, at position 0, as one entry standing for the file whole
      // until a build counts its pages (docs/03 §3.3.17).
      expect(
        await prisma.documentPage.findMany({
          where: { documentId: document.id },
          select: { position: true, fileId: true, pageIndex: true },
        }),
      ).toEqual([{ position: 0, fileId: file.id, pageIndex: null }]);
      expect(await countProcessJobs()).toBe(1);
    });

    it('gives two paths with identical content one document and two refs, running the pipeline once', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a/one.txt', 'same bytes');
      await writeFixture('b/two.txt', 'same bytes');

      await scan.handle({ libraryId });
      expect(await runIngests()).toBe(2);

      // 🔒 The dedup guarantee, one level down since ADR-021: one content, one *file*, and one
      // document holding it.
      expect(await prisma.file.count()).toBe(1);
      expect(await prisma.document.count()).toBe(1);
      const found = await refs(libraryId);
      expect(found).toHaveLength(2);
      expect(new Set(found.map((ref) => ref.fileId)).size).toBe(1);
      // …and the pipeline was started exactly once.
      expect(await countProcessJobs()).toBe(1);
    });

    // 🔒 The two halves of "a deleted document stays deleted", proven against a real scan: the
    // original is still on the volume, and nothing here may hand it a new document (docs/05 §5.3,
    // §5.7a, docs/03 §3.3.9).
    it('leaves an excluded path alone, and never re-homes a file that is in the trash', async () => {
      const libraryId = await createLibrary();
      await writeFixture('deleted.txt', 'the bytes of a deleted document');
      await scan.handle({ libraryId });
      await runIngests();

      const file = await prisma.file.findFirstOrThrow();
      const document = await prisma.document.findFirstOrThrow();
      // What an admin deleting the document leaves behind: the file in the trash, its paths
      // excluded, the document row gone.
      await prisma.documentPage.deleteMany({ where: { documentId: document.id } });
      await prisma.document.delete({ where: { id: document.id } });
      await prisma.fileRef.updateMany({
        where: { fileId: file.id },
        data: { status: 'EXCLUDED', fileId: null },
      });
      await prisma.file.update({
        where: { id: file.id },
        data: { trashedAt: new Date(), trashedReason: 'DOCUMENT_DELETED', trashedFrom: 'report' },
      });

      // The scan that follows — the one that used to bring the document straight back.
      await scan.handle({ libraryId });
      expect(await runIngests()).toBe(0);
      expect(await prisma.document.count()).toBe(0);
      expect((await refs(libraryId)).map((ref) => ref.status)).toEqual(['EXCLUDED']);

      // And when the bytes at that path change, it is a different file and is read like any other.
      await writeFixture('deleted.txt', 'somebody put something else here');
      await scan.handle({ libraryId });
      expect(await runIngests()).toBe(1);
      expect(await prisma.document.count()).toBe(1);
    });

    // The same guard from the other side: a copy of a file that is in the trash turns up at a path
    // with no ref of its own, so ingest reaches question two and must not answer "it has no home".
    it('gives a copy of a trashed file no document of its own', async () => {
      const libraryId = await createLibrary();
      await writeFixture('original.txt', 'these very bytes');
      await scan.handle({ libraryId });
      await runIngests();

      const file = await prisma.file.findFirstOrThrow();
      const document = await prisma.document.findFirstOrThrow();
      await prisma.documentPage.deleteMany({ where: { documentId: document.id } });
      await prisma.document.delete({ where: { id: document.id } });
      await prisma.file.update({
        where: { id: file.id },
        data: { trashedAt: new Date(), trashedReason: 'REPLACED' },
      });

      await writeFixture('a-copy.txt', 'these very bytes');
      await scan.handle({ libraryId });
      await runIngests();

      // One file, as deduplication promises — and still no document, because the file is in the
      // trash and that is an answer to "where does this belong".
      expect(await prisma.file.count()).toBe(1);
      expect(await prisma.document.count()).toBe(0);
    });

    it('detects the format from content, not the extension', async () => {
      const libraryId = await createLibrary();
      // A real 1x1 PNG in a file named .txt: content must win over the extension.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      );
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'liar.txt'), png);

      await scan.handle({ libraryId });
      await runIngests();

      const file = await prisma.file.findFirstOrThrow();
      expect(file.mimeType).toBe('image/png');
      expect(file.ext).toBe('png');
    });

    it('gives up on a tree larger than SCAN_MAX_FILES rather than ingesting a whole disk', async () => {
      const libraryId = await createLibrary();
      await writeFixture('one.txt', '1');
      await writeFixture('two.txt', '2');
      await writeFixture('three.txt', '3');

      // The same handler the container builds, with the limit an operator would set (docs/05 §5.2).
      const capped = new HandleLibraryScan(
        moduleRef.get(LibraryRepository),
        moduleRef.get(FileRefRepository),
        moduleRef.get(ScanRunRepository),
        moduleRef.get(LibraryReader),
        moduleRef.get(JobQueue),
        moduleRef.get(Clock),
        2,
      );

      await capped.handle({ libraryId });

      const run = await latestRun(libraryId);
      expect(run.status).toBe('FAILED');
      // The message has to say what to change; the number alone helps nobody.
      expect(run.error).toContain('SCAN_MAX_FILES');
      // 🔒 The point of the guard: nothing downstream was scheduled.
      const queued = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        "SELECT count(*) FROM pgboss.job WHERE name = 'file-ingest'",
      );
      expect(Number(queued[0]?.count ?? 0)).toBe(0);
    });

    it('takes the same tree once the limit allows it', async () => {
      const libraryId = await createLibrary();
      await writeFixture('one.txt', '1');
      await writeFixture('two.txt', '2');

      await scan.handle({ libraryId });

      // The refs the capped pass left behind are ordinary DISCOVERED refs; a scan with room simply
      // ingests them.
      expect((await latestRun(libraryId)).status).toBe('DONE');
      expect(await refs(libraryId)).toHaveLength(2);
    });

    it('is idempotent under double delivery', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'a');
      await scan.handle({ libraryId });

      const jobs = await prisma.$queryRawUnsafe<{ data: { fileRefId: string } }[]>(
        "SELECT data FROM pgboss.job WHERE name = 'file-ingest'",
      );
      const payload = jobs[0]?.data;
      if (payload === undefined) throw new Error('no ingest job queued');

      await ingest.handle(payload);
      await ingest.handle(payload);

      expect(await prisma.document.count()).toBe(1);
      expect(await refs(libraryId)).toHaveLength(1);
      // The second delivery returned early, so the pipeline was not started twice.
      expect(await countProcessJobs()).toBe(1);
    });

    it('does nothing for a ref whose library was deleted meanwhile', async () => {
      const libraryId = await createLibrary();
      await writeFixture('a.txt', 'a');
      await scan.handle({ libraryId });
      await prisma.library.update({ where: { id: libraryId }, data: { deletedAt: new Date() } });

      const jobs = await prisma.$queryRawUnsafe<{ data: { fileRefId: string } }[]>(
        "SELECT data FROM pgboss.job WHERE name = 'file-ingest'",
      );
      await ingest.handle(jobs[0]?.data ?? {});

      expect(await prisma.document.count()).toBe(0);
    });
  });

  describe('renames, returns and availability (docs/05 §5.7)', () => {
    it('treats a rename as the old path missing and the new one attached to the same document', async () => {
      const libraryId = await createLibrary();
      await writeFixture('before.txt', 'stable content');
      await scan.handle({ libraryId });
      await runIngests();
      const document = await prisma.document.findFirstOrThrow();

      await rename(join(root, 'before.txt'), join(root, 'after.txt'));
      await scan.handle({ libraryId });
      await runIngests();

      const found = await refs(libraryId);
      const before = found.find((ref) => ref.path === 'before.txt');
      const after = found.find((ref) => ref.path === 'after.txt');

      expect(before?.status).toBe('MISSING');
      expect(after?.status).toBe('HASHED');
      // 🔒 The document is untouched: same row, same id, and the pipeline never ran again.
      expect(await prisma.document.count()).toBe(1);
      const file = await prisma.file.findFirstOrThrow();
      expect(after?.fileId).toBe(file.id);
      expect(await prisma.documentPage.count({ where: { documentId: document.id } })).toBe(1);
      expect(await countProcessJobs()).toBe(1);
    });

    it('restores availability when a file comes back', async () => {
      const libraryId = await createLibrary();
      await writeFixture('away.txt', 'comes back');
      await scan.handle({ libraryId });
      await runIngests();
      const file = await prisma.file.findFirstOrThrow();

      await rm(join(root, 'away.txt'));
      await scan.handle({ libraryId });
      expect((await refs(libraryId))[0]?.status).toBe('MISSING');
      // Unavailable: no live ref left pointing at the file (docs/05 §5.7).
      expect(await prisma.fileRef.count({ where: { fileId: file.id, status: 'HASHED' } })).toBe(0);

      await writeFixture('away.txt', 'comes back');
      await scan.handle({ libraryId });
      await runIngests();

      const restored = (await refs(libraryId))[0];
      expect(restored?.status).toBe('HASHED');
      expect(restored?.missingSince).toBeNull();
      expect(restored?.fileId).toBe(file.id);
      // Still one document, still processed once.
      expect(await prisma.document.count()).toBe(1);
      expect(await countProcessJobs()).toBe(1);
    });
  });

  describe('queue integration', () => {
    it('enqueues per-library scans under a singleton key', async () => {
      const libraryId = await createLibrary();

      const first = await queue.enqueue('library-scan', { libraryId }, { singletonKey: libraryId });
      const second = await queue.enqueue(
        'library-scan',
        { libraryId },
        { singletonKey: libraryId },
      );

      expect(first).not.toBeNull();
      // One scan per library at a time (docs/05 §5.2).
      expect(second).toBeNull();
    });

    // Found by running the app: "Scan now" while the periodic sweep already had a scan queued left
    // a RUNNING row with no job behind it, and scan_runs_running_uq then blocked every later scan of
    // that library — the library simply stopped being scanned, silently.
    it('answers alreadyRunning without leaving a run behind when the queue collapses the job', async () => {
      const libraryId = await createLibrary();
      await queue.enqueue('library-scan', { libraryId }, { singletonKey: libraryId });

      const result = await triggerScan.execute(libraryId);

      expect(result).toEqual({ alreadyRunning: true });
      expect(await prisma.scanRun.count({ where: { libraryId } })).toBe(0);
    });

    it('adopts a RUNNING run left behind by a crash instead of refusing to scan', async () => {
      const libraryId = await createLibrary();
      await writeFixture('orphaned.txt', 'still here');
      const stale = await prisma.scanRun.create({
        data: { libraryId, status: 'RUNNING', startedAt: new Date('2026-01-01T00:00:00.000Z') },
      });

      await scan.handle({ libraryId });

      const adopted = await prisma.scanRun.findUniqueOrThrow({ where: { id: stale.id } });
      expect(adopted.status).toBe('DONE');
      expect(adopted.filesSeen).toBe(1);
      // One journal entry, not a second one alongside a stuck first.
      expect(await prisma.scanRun.count({ where: { libraryId } })).toBe(1);
      expect((await refs(libraryId)).map((ref) => ref.path)).toEqual(['orphaned.txt']);
    });
  });
});
