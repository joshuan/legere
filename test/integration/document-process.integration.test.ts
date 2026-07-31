import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HandleDocumentProcess } from '../../src/server/application/jobs/handle-document-process';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { DocumentRepository } from '../../src/server/domain/repositories/document.repository';
import { FileRefRepository } from '../../src/server/domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../src/server/domain/repositories/library.repository';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { InMemoryFileStorage } from '../../src/server/infrastructure/storage/in-memory-file-storage';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';
import { FakeImageTool, FakePdfToolbox, StubLibraryReader } from '../helpers/processing-fakes';

const SOURCE_PATH = 'a.pdf';

// The pipeline against the real database (docs/14 §14.8): what the unit suite asserts in memory has
// to survive the round trip through Prisma — the step columns, the page count and the error column
// with its 2000-character cap (docs/03 §3.3.10).
describe('Document processing (integration)', () => {
  let prisma: PrismaService;
  let handler: HandleDocumentProcess;
  let files: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let reader: StubLibraryReader;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, PersistenceModule],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    close = () => moduleRef.close();

    files = new InMemoryFileStorage();
    pdfs = new FakePdfToolbox();
    reader = new StubLibraryReader();
    reader.put(SOURCE_PATH, 'source-bytes');

    handler = new HandleDocumentProcess(
      moduleRef.get(DocumentRepository),
      moduleRef.get(FileRefRepository),
      moduleRef.get(LibraryRepository),
      reader,
      files,
      pdfs,
      new FakeImageTool(),
      { previewMaxDim: 1600, thumbMaxDim: 400 },
    );

    await truncateAll();
  });

  beforeEach(async () => {
    await truncateAll();
    files.clear();
    pdfs.calls.length = 0;
    pdfs.failures.clear();
    pdfs.failureDetail = '';
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  async function givenLibraryDocument(mimeType = 'application/pdf'): Promise<string> {
    const library = await prisma.library.create({
      data: {
        name: 'Fixtures',
        rootPath: '',
        visibility: 'ALL_USERS',
        excludeGlobs: [],
        scanIntervalMinutes: 15,
      },
    });
    const document = await prisma.document.create({
      data: {
        contentHash: 'b'.repeat(64),
        source: 'LIBRARY',
        mimeType,
        ext: 'pdf',
        sizeBytes: 12n,
        title: 'Invoice',
      },
    });
    await prisma.fileRef.create({
      data: {
        libraryId: library.id,
        documentId: document.id,
        path: SOURCE_PATH,
        size: 12n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: 'b'.repeat(64),
      },
    });
    return document.id;
  }

  it('writes the step statuses and the page count to the document row', async () => {
    const documentId = await givenLibraryDocument();
    pdfs.pageCount = 42;

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.canonicalStatus).toBe('SKIPPED');
    expect(row.previewStatus).toBe('DONE');
    expect(row.pageCount).toBe(42);
    expect(row.processingError).toBeNull();
    expect(files.keys()).toEqual([
      artifactKeys.preview(documentId),
      artifactKeys.thumbnail(documentId),
    ]);
  });

  it('caps a runaway error message instead of storing an HTML page in the column', async () => {
    const documentId = await givenLibraryDocument();
    // A sibling container answering with a full HTML error page is the realistic case.
    pdfs.failureDetail = '<html><body>Internal Server Error</body></html>'.repeat(200);
    pdfs.failOn('pdfFirstPageJpg');

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.previewStatus).toBe('FAILED');
    expect(row.failedStep).toBe('preview');
    expect((row.processingError ?? '').length).toBe(2000);
    expect(row.processingError?.endsWith('…')).toBe(true);
  });

  it('finds the file to read through the live ref of the document', async () => {
    const documentId = await givenLibraryDocument();

    await handler.handle({ documentId });

    expect(reader.opened).toContain(SOURCE_PATH);
  });

  it('leaves an unsupported format settled without any artifact', async () => {
    const documentId = await givenLibraryDocument('application/x-executable');

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.canonicalStatus).toBe('SKIPPED');
    expect(row.previewStatus).toBe('SKIPPED');
    expect(row.markdownStatus).toBe('SKIPPED');
    expect(row.vectorizationStatus).toBe('SKIPPED');
    expect(row.categorizationStatus).toBe('PENDING');
    expect(files.keys()).toEqual([]);
  });
});
