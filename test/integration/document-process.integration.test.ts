import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HandleDocumentProcess } from '../../src/server/application/jobs/handle-document-process';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { DocumentTypeRepository } from '../../src/server/domain/repositories/document-type.repository';
import { DocumentChunkRepository } from '../../src/server/domain/repositories/document-chunk.repository';
import { DocumentEventRepository } from '../../src/server/domain/repositories/document-event.repository';
import { PersonRepository } from '../../src/server/domain/repositories/person.repository';
import { SubjectKindRepository } from '../../src/server/domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../src/server/domain/repositories/subject.repository';
import { DocumentRepository } from '../../src/server/domain/repositories/document.repository';
import { FileRefRepository } from '../../src/server/domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../src/server/domain/repositories/library.repository';
import { UnitOfWork } from '../../src/server/application/ports/unit-of-work';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { InMemoryFileStorage } from '../../src/server/infrastructure/storage/in-memory-file-storage';
import { disconnectTestPrisma, truncateAll } from '../helpers/db';
import {
  FakeAnalyst,
  FakeCallContext,
  FakeEmbeddingProvider,
  FakeImageTool,
  FakeDocumentParser,
  FakePdfToolbox,
  StubLibraryReader,
} from '../helpers/processing-fakes';

const SOURCE_PATH = 'a.pdf';

// The pipeline against the real database (docs/14 §14.8): what the unit suite asserts in memory has
// to survive the round trip through Prisma — the step columns, the page count and the error column
// with its 2000-character cap (docs/03 §3.3.10).
describe('Document processing (integration)', () => {
  let prisma: PrismaService;
  let handler: HandleDocumentProcess;
  let files: InMemoryFileStorage;
  let pdfs: FakePdfToolbox;
  let parser: FakeDocumentParser;
  let analyst: FakeAnalyst;
  let embeddings: FakeEmbeddingProvider;
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
    parser = new FakeDocumentParser();
    pdfs.defaultMarkdown = 'Invoice 2026-01 for consulting services, payable within thirty days';
    analyst = new FakeAnalyst();
    embeddings = new FakeEmbeddingProvider();
    // The column is vector(1536) (docs/04 §4.3); a provider of another width is a configuration
    // error, which is what the unit suite covers.
    embeddings.dimensions = 1536;
    reader = new StubLibraryReader();
    reader.put(SOURCE_PATH, 'source-bytes');

    handler = new HandleDocumentProcess(
      moduleRef.get(DocumentRepository),
      moduleRef.get(DocumentEventRepository),
      moduleRef.get(FileRefRepository),
      moduleRef.get(LibraryRepository),
      reader,
      files,
      pdfs,
      parser,
      new FakeImageTool(),
      moduleRef.get(DocumentTypeRepository),
      analyst,
      moduleRef.get(PersonRepository),
      moduleRef.get(SubjectRepository),
      moduleRef.get(SubjectKindRepository),
      moduleRef.get(DocumentChunkRepository),
      embeddings,
      moduleRef.get(UnitOfWork),
      new FakeCallContext(),
      {
        previewMaxDim: 1600,
        thumbMaxDim: 400,
        ocrLanguages: ['eng'],
        pdfTextMinCharsPerPage: 32,
        chunkTargetChars: 200,
        chunkOverlapChars: 40,
      },
    );

    await truncateAll();
  });

  beforeEach(async () => {
    await truncateAll();
    files.clear();
    pdfs.calls.length = 0;
    pdfs.failures.clear();
    pdfs.failureDetail = '';
    pdfs.markdownFailing = false;
    pdfs.markdownReads.length = 0;
    // The page count decides the OCR threshold now, so a count left behind by an earlier test would
    // silently turn the next document into a "scan".
    pdfs.pageCount = 1;
    analyst.slug = null;
    analyst.configured = true;
    analyst.failing = false;
    embeddings.configured = true;
    embeddings.failing = false;
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

  it('stores the Markdown where the full-text index picks it up', async () => {
    const documentId = await givenLibraryDocument();

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.markdownStatus).toBe('DONE');
    expect(row.markdown).toContain('consulting services');
    expect(row.ocrUsed).toBe(false);

    // 🔒 search_vector is generated from title + markdown (docs/04 §4.3): writing the column is what
    // makes the document findable, with no separate indexing step to forget.
    const hits = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM documents WHERE search_vector @@ websearch_to_tsquery('simple', $1)`,
      'consulting',
    );
    expect(hits.map((hit) => hit.id)).toEqual([documentId]);

    // The title feeds the same vector, weighted higher.
    const byTitle = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM documents WHERE search_vector @@ websearch_to_tsquery('simple', $1)`,
      'invoice',
    );
    expect(byTitle.map((hit) => hit.id)).toEqual([documentId]);
  });

  it('stores text with characters no single-byte encoding could carry', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    reader.put(SOURCE_PATH, Buffer.from('Счёт за январь — 1 200 ₽', 'utf8'));

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.markdown).toBe('Счёт за январь — 1 200 ₽');
  });

  it('writes chunks with their vectors into pgvector, replacing them wholesale on a re-run', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    reader.put(SOURCE_PATH, 'The first body of this document, long enough to be worth embedding.');

    await handler.handle({ documentId });

    const first = await prisma.$queryRawUnsafe<{ index: number; content: string; dims: number }[]>(
      `SELECT index, content, vector_dims(embedding) AS dims
       FROM document_chunks WHERE document_id = $1::uuid ORDER BY index`,
      documentId,
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.content).toContain('first body');
    expect(Number(first[0]?.dims)).toBe(1536);
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).vectorizationStatus,
    ).toBe('DONE');

    // A re-run with different text replaces the set rather than adding to it (docs/03 §3.3.11).
    reader.put(SOURCE_PATH, 'A completely different body.\n\nWith a second paragraph in it.');
    await handler.handle({ documentId });

    const second = await prisma.$queryRawUnsafe<{ content: string }[]>(
      `SELECT content FROM document_chunks WHERE document_id = $1::uuid ORDER BY index`,
      documentId,
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.content).toContain('completely different');
  });

  it('finds a chunk by cosine distance, which is what semantic search will do', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    reader.put(SOURCE_PATH, 'Searchable body text.');

    await handler.handle({ documentId });

    // The same query the search use case will run (docs/04 §4.5): nearest neighbours by cosine.
    const query = `[${Array.from({ length: 1536 }, (_, index) => (index === 1 ? 21 : 0)).join(',')}]`;
    const nearest = await prisma.$queryRawUnsafe<{ document_id: string; distance: number }[]>(
      `SELECT document_id, embedding <=> $1::vector AS distance
       FROM document_chunks ORDER BY embedding <=> $1::vector LIMIT 1`,
      query,
    );
    expect(nearest[0]?.document_id).toBe(documentId);
  });

  it('assigns the documentType the analyst chose, and never overwrites a manual one', async () => {
    const documentType = await prisma.documentType.create({
      data: { slug: 'invoice', name: 'Invoice', description: 'Bills and payment requests.' },
    });
    const documentId = await givenLibraryDocument('text/plain');
    reader.put(SOURCE_PATH, 'Amount due: 1200.');
    analyst.slug = 'invoice';

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.typeId).toBe(documentType.id);
    expect(row.typeSource).toBe('AUTO');
    expect(row.analysisStatus).toBe('DONE');

    // A person moves it elsewhere; the next run must leave that alone.
    await prisma.document.update({
      where: { id: documentId },
      data: { typeId: null, typeSource: 'MANUAL' },
    });
    await handler.handle({ documentId });

    const after = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(after.typeSource).toBe('MANUAL');
    expect(after.typeId).toBeNull();
    expect(after.analysisStatus).toBe('SKIPPED');
  });

  it('skips both AI steps, without error, when no provider is configured', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    reader.put(SOURCE_PATH, 'Body text.');
    analyst.configured = false;
    embeddings.configured = false;

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.analysisStatus).toBe('SKIPPED');
    expect(row.vectorizationStatus).toBe('SKIPPED');
    expect(row.processingError).toBeNull();
    expect(await prisma.documentChunk.count({ where: { documentId } })).toBe(0);
  });

  it('leaves an unsupported format settled without any artifact', async () => {
    await prisma.documentType.create({ data: { slug: 'other', name: 'Other' } });
    const documentId = await givenLibraryDocument('application/x-executable');

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.canonicalStatus).toBe('SKIPPED');
    expect(row.previewStatus).toBe('SKIPPED');
    expect(row.markdownStatus).toBe('SKIPPED');
    expect(row.vectorizationStatus).toBe('SKIPPED');
    // Nothing is left PENDING: the document is finished, not forever in progress.
    expect(row.analysisStatus).toBe('DONE');
    expect(files.keys()).toEqual([]);
  });
});
