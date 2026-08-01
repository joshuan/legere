import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HandleScanSetMerge } from '../../src/server/application/jobs/handle-scanset-merge';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { UnitOfWork } from '../../src/server/application/ports/unit-of-work';
import { DocumentRepository } from '../../src/server/domain/repositories/document.repository';
import { FileRefRepository } from '../../src/server/domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../src/server/domain/repositories/library.repository';
import { ScanSetRepository } from '../../src/server/domain/repositories/scan-set.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { InMemoryFileStorage } from '../../src/server/infrastructure/storage/in-memory-file-storage';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';
import { FakeImageTool, FakePdfToolbox, StubLibraryReader } from '../helpers/processing-fakes';

// The merge job against the real database (docs/05 §5.6): pages in, one derived document out.
describe('Scan set merge (integration)', () => {
  let prisma: PrismaService;
  let handler: HandleScanSetMerge;
  let scanSets: ScanSetRepository;
  let files: InMemoryFileStorage;
  let images: FakeImageTool;
  let pdfs: FakePdfToolbox;
  let reader: StubLibraryReader;
  let close: () => Promise<void>;
  let enqueued: { name: string; payload: unknown }[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    scanSets = moduleRef.get(ScanSetRepository);
    close = () => moduleRef.close();

    files = new InMemoryFileStorage();
    images = new FakeImageTool();
    pdfs = new FakePdfToolbox();
    reader = new StubLibraryReader();

    handler = new HandleScanSetMerge(
      scanSets,
      moduleRef.get(DocumentRepository),
      moduleRef.get(FileRefRepository),
      moduleRef.get(LibraryRepository),
      reader,
      files,
      images,
      pdfs,
      {
        enqueue: (name, payload) => {
          enqueued.push({ name, payload });
          return Promise.resolve('job');
        },
        enqueueAfterTx: (_tx, name, payload) => {
          enqueued.push({ name, payload });
          return Promise.resolve('job');
        },
        scheduleCron: () => Promise.resolve(),
        unscheduleCron: () => Promise.resolve(),
      },
      moduleRef.get(UnitOfWork),
    );

    await truncateAll();
  });

  beforeEach(async () => {
    await truncateAll();
    files.clear();
    images.resizes.length = 0;
    images.trims.length = 0;
    pdfs.calls.length = 0;
    pdfs.failures.clear();
    enqueued = [];
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  let seq = 0;

  async function givenScanSet(
    cropMode: 'TRIM' | 'NONE' = 'TRIM',
    pages = 2,
  ): Promise<{ scanSetId: string; ownerId: string }> {
    seq += 1;
    const user = await prisma.user.create({
      data: {
        email: `scanner${seq}@legere.local`,
        passwordHash: 'x',
        displayName: 'Scanner',
        role: 'USER',
      },
    });
    const library = await prisma.library.create({
      data: {
        name: `Scans ${seq}`,
        // Active libraries may not nest, so each fixture gets its own root (docs/03 §3.3.6).
        rootPath: `scans-${seq}`,
        visibility: 'ALL_USERS',
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });

    const scanSet = await prisma.scanSet.create({
      data: { name: `Passport ${seq}`, createdById: user.id, cropMode },
    });

    for (let page = 0; page < pages; page += 1) {
      seq += 1;
      const hash = `${seq}`.padStart(64, '3');
      const document = await prisma.document.create({
        data: {
          contentHash: hash,
          source: 'LIBRARY',
          mimeType: 'image/jpeg',
          ext: 'jpg',
          sizeBytes: 10n,
          title: `Page ${page}`,
        },
      });
      await prisma.fileRef.create({
        data: {
          libraryId: library.id,
          documentId: document.id,
          path: `page-${seq}.jpg`,
          size: 10n,
          mtime: new Date('2026-01-01T00:00:00.000Z'),
          status: 'HASHED',
          contentHash: hash,
        },
      });
      reader.put(`page-${seq}.jpg`, `page-${page}-bytes`);
      await prisma.scanSetItem.create({
        data: { scanSetId: scanSet.id, documentId: document.id, position: page },
      });
    }

    return { scanSetId: scanSet.id, ownerId: user.id };
  }

  it('merges the pages into a derived document owned by the person who built the set', async () => {
    const { scanSetId, ownerId } = await givenScanSet();

    await handler.handle({ scanSetId });

    const row = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    expect(row.status).toBe('DONE');
    expect(row.resultDocumentId).not.toBeNull();

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: row.resultDocumentId ?? '' },
    });
    expect(document).toMatchObject({
      source: 'DERIVED',
      mimeType: 'application/pdf',
      createdById: ownerId,
      // Provenance: which scan set produced it (docs/05 §5.6).
      scanSetId,
      title: document.title,
    });
    // The merged PDF is the document's source, in the bucket rather than on a volume.
    expect(files.keys()).toEqual([artifactKeys.derivedSource(document.id)]);
    // And it goes through the ordinary pipeline like anything else.
    expect(enqueued).toEqual([{ name: 'document-process', payload: { documentId: document.id } }]);
  });

  it('sends the pages to the merger in page order', async () => {
    const { scanSetId } = await givenScanSet('TRIM', 3);

    await handler.handle({ scanSetId });

    const merge = pdfs.calls.find((call) => call.method === 'imagesToPdf');
    expect(merge?.fileName).toBe('page-0000.jpg,page-0001.jpg,page-0002.jpg');
  });

  it('trims every page when the set says TRIM, and none when it says NONE', async () => {
    const trimmed = await givenScanSet('TRIM', 2);
    await handler.handle({ scanSetId: trimmed.scanSetId });
    expect(images.trims).toHaveLength(2);

    images.trims.length = 0;
    const untouched = await givenScanSet('NONE', 2);
    await handler.handle({ scanSetId: untouched.scanSetId });
    // 🔒 NONE keeps the frame the photographer chose (docs/05 §5.6).
    expect(images.trims).toEqual([]);
  });

  it('reuses the document when the same set is merged again, without processing it twice', async () => {
    const { scanSetId } = await givenScanSet('TRIM', 1);
    await handler.handle({ scanSetId });
    const first = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    enqueued = [];

    // A retry after an edit that happened to produce the same bytes.
    await prisma.scanSet.update({ where: { id: scanSetId }, data: { status: 'QUEUED' } });
    await handler.handle({ scanSetId });

    const again = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    // Same bytes, same document (ADR-009, docs/05 §5.6) — and no second trip through the pipeline.
    expect(again.resultDocumentId).toBe(first.resultDocumentId);
    expect(await prisma.document.count({ where: { source: 'DERIVED' } })).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('refuses to steal a result that already belongs to another scan set', async () => {
    const first = await givenScanSet('TRIM', 1);
    await handler.handle({ scanSetId: first.scanSetId });

    // A different set whose pages merge to the same bytes.
    const second = await givenScanSet('TRIM', 1);
    await handler.handle({ scanSetId: second.scanSetId });

    const row = await prisma.scanSet.findUniqueOrThrow({ where: { id: second.scanSetId } });
    // One document per content, one scan set per result document (docs/04 §4.1, §4.3): the second
    // set is told where its content already lives instead of duplicating it.
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('already belongs to the scan set');
    expect(await prisma.document.count({ where: { source: 'DERIVED' } })).toBe(1);
  });

  it('records a failure on the set and leaves it editable', async () => {
    const { scanSetId } = await givenScanSet();
    pdfs.failOn('imagesToPdf');

    await handler.handle({ scanSetId });

    const row = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('imagesToPdf failed');
    // Nothing half-written: no document, no object in the bucket.
    expect(await prisma.document.count({ where: { source: 'DERIVED' } })).toBe(0);
    expect(files.keys()).toEqual([]);
  });

  it('fails when a page has gone missing from the volume', async () => {
    const { scanSetId } = await givenScanSet();
    await prisma.fileRef.updateMany({ data: { status: 'MISSING', missingSince: new Date() } });

    await handler.handle({ scanSetId });

    const row = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('no longer available');
  });

  it('does nothing when the job is delivered twice', async () => {
    const { scanSetId } = await givenScanSet();
    await handler.handle({ scanSetId });
    const first = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    enqueued = [];

    await handler.handle({ scanSetId });

    const second = await prisma.scanSet.findUniqueOrThrow({ where: { id: scanSetId } });
    expect(second.resultDocumentId).toBe(first.resultDocumentId);
    expect(await prisma.document.count({ where: { source: 'DERIVED' } })).toBe(1);
    expect(enqueued).toEqual([]);
  });

  it('ignores a job for a scan set that was deleted', async () => {
    const { scanSetId } = await givenScanSet();
    await prisma.scanSet.update({ where: { id: scanSetId }, data: { deletedAt: new Date() } });

    await handler.handle({ scanSetId });

    expect(await prisma.document.count({ where: { source: 'DERIVED' } })).toBe(0);
  });
});
