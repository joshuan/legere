import { FixedClock } from '../helpers/fakes';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BuildCanonical } from '../../src/server/application/documents/build-canonical';
import { HandleDocumentProcess } from '../../src/server/application/jobs/handle-document-process';
import { artifactKeys } from '../../src/server/application/storage/artifact-keys';
import { QueueSettings, ungatedServices } from '../../src/server/application/queue/queue-settings';
import { DocumentTypeRepository } from '../../src/server/domain/repositories/document-type.repository';
import {
  DocumentChunkRepository,
  type NewDocumentChunk,
} from '../../src/server/domain/repositories/document-chunk.repository';
import { DocumentEventRepository } from '../../src/server/domain/repositories/document-event.repository';
import { PersonRepository } from '../../src/server/domain/repositories/person.repository';
import { SubjectKindRepository } from '../../src/server/domain/repositories/subject-kind.repository';
import { SubjectRepository } from '../../src/server/domain/repositories/subject.repository';
import { DocumentRepository } from '../../src/server/domain/repositories/document.repository';
import { withFilePageOrder } from '../../src/server/domain/entities/document-page';
import { FileRepository } from '../../src/server/domain/repositories/file.repository';
import { FileRefRepository } from '../../src/server/domain/repositories/file-ref.repository';
import { LibraryRepository } from '../../src/server/domain/repositories/library.repository';
import { SettingsRepository } from '../../src/server/domain/repositories/settings.repository';
import {
  UnitOfWork,
  type TransactionHandle,
} from '../../src/server/application/ports/unit-of-work';
import { AnalysisSettings } from '../../src/server/application/settings/analysis-settings';
import { ConfigModule } from '../../src/server/infrastructure/config/config.module';
import { isPrismaTx } from '../../src/server/infrastructure/persistence/prisma-client';
import { PersistenceModule } from '../../src/server/infrastructure/persistence/persistence.module';
import { PrismaService } from '../../src/server/infrastructure/persistence/prisma.service';
import { InMemoryFileStorage } from '../../src/server/infrastructure/storage/in-memory-file-storage';
import { EMBEDDING_WIDTH, disconnectTestPrisma, embeddingOf, truncateAll } from '../helpers/db';
import {
  FakeAnalyst,
  FakeTranscriber,
  FakeCallContext,
  InMemorySettingsRepository,
  FakeEmbeddingProvider,
  FakeImageTool,
  FakeDocumentParser,
  FakePdfToolbox,
  queueSettingsFixture,
  StubLibraryReader,
} from '../helpers/processing-fakes';

const SOURCE_PATH = 'a.pdf';

// Past Prisma's own 5 s bound on an interactive transaction — the bound the live instance's
// vectorization kept hitting (docs/06 §6.3.4).
const HOLD_PAST_DRIVER_DEFAULT_MS = 6_000;

// What the canonical reads as unless a test says otherwise: comfortably over the per-page threshold,
// so the default path is "this PDF carries its own text".
const DEFAULT_TEXT = 'Invoice 2026-01 for consulting services, payable within thirty days';

// The pipeline against the real database (docs/14 §14.8): what the unit suite asserts in memory has
// to survive the round trip through Prisma — the step columns, the page count of the canonical and
// the error column with its 2000-character cap (docs/03 §3.3.10).
describe('Document processing (integration)', () => {
  let prisma: PrismaService;
  let handler: HandleDocumentProcess;
  let files: InMemoryFileStorage;
  // The repository, beside the bucket above: a composition edit is a rewrite of the document's own
  // list of pages (docs/03 §3.3.17).
  let fileRepo: FileRepository;
  let pdfs: FakePdfToolbox;
  let parser: FakeDocumentParser;
  let analyst: FakeAnalyst;
  let embeddings: FakeEmbeddingProvider;
  let reader: StubLibraryReader;
  // The real chunk repository, with a tap that can hold its transaction open (see the class below).
  let chunks: SlowChunkRepository;
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
    analyst = new FakeAnalyst();
    embeddings = new FakeEmbeddingProvider();
    // The column's width is the schema's (docs/04 §4.3); a provider of another width is a
    // configuration error, which is what the unit suite covers.
    embeddings.dimensions = EMBEDDING_WIDTH;
    reader = new StubLibraryReader();
    reader.put(SOURCE_PATH, 'source-bytes');

    const settings = {
      previewMaxDim: 1600,
      thumbMaxDim: 400,
      ocrLanguages: ['eng'],
      pdfTextMinCharsPerPage: 32,
      correctImagePages: true,
      chunkTargetChars: 200,
      chunkOverlapChars: 40,
      analystExcerptChars: 0,
      analystMaxPageImages: 20,
      analystPageImageMaxDim: 1200,
      analystAutoMaxPages: 0,
      transcriberMaxPages: 0,
      transcriberPageImageMaxDim: 1600,
    };

    fileRepo = moduleRef.get(FileRepository);
    chunks = new SlowChunkRepository(moduleRef.get(DocumentChunkRepository));
    handler = new HandleDocumentProcess(
      moduleRef.get(DocumentRepository),
      moduleRef.get(DocumentEventRepository),
      new BuildCanonical(
        moduleRef.get(FileRepository),
        moduleRef.get(FileRefRepository),
        moduleRef.get(LibraryRepository),
        reader,
        files,
        new FakeImageTool(),
        pdfs,
        new QueueSettings(moduleRef.get(SettingsRepository), {
          concurrency: {
            'library-scan': 1,
            'file-ingest': 1,
            'document-process': 1,
            maintenance: 1,
          },
          unitConcurrency: 4,
          services: ungatedServices(),
        }),
        settings,
      ),
      files,
      pdfs,
      parser,
      new FakeImageTool(),
      moduleRef.get(DocumentTypeRepository),
      analyst,
      new FakeTranscriber(),
      moduleRef.get(PersonRepository),
      moduleRef.get(SubjectRepository),
      moduleRef.get(SubjectKindRepository),
      chunks,
      embeddings,
      moduleRef.get(UnitOfWork),
      new FakeCallContext(),
      new AnalysisSettings(new InMemorySettingsRepository()),
      // Nothing paused: this suite is about the pipeline running, and the pause has its own tests
      // (docs/05 §5.4d).
      queueSettingsFixture(),
      settings,
      new FixedClock(),
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
    pdfs.markdownByContent.clear();
    // Reset per test: what the canonical is read as decides both the OCR branch and the chunks, so
    // text left behind by an earlier test would quietly become the next document's body.
    pdfs.defaultMarkdown = DEFAULT_TEXT;
    // The page count decides the OCR threshold now, so a count left behind by an earlier test would
    // silently turn the next document into a "scan".
    pdfs.pageCount = 1;
    analyst.slug = null;
    analyst.configured = true;
    analyst.failing = false;
    embeddings.configured = true;
    embeddings.failing = false;
    chunks.holdMs = 0;
  });

  afterAll(async () => {
    await close();
    await disconnectTestPrisma();
  });

  // A document of one library file: the row, the file it holds, and the ref that says where the
  // bytes are (docs/03 §3.3.16–3.3.17).
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
    const document = await prisma.document.create({ data: { title: 'Invoice' } });
    const file = await prisma.file.create({
      data: {
        contentHash: 'b'.repeat(64),
        origin: 'LIBRARY',
        mimeType,
        ext: 'pdf',
        sizeBytes: 12n,
        name: SOURCE_PATH,
      },
    });
    await prisma.documentPage.create({
      data: { documentId: document.id, position: 0, fileId: file.id, pageIndex: null },
    });
    await prisma.fileRef.create({
      data: {
        libraryId: library.id,
        fileId: file.id,
        path: SOURCE_PATH,
        size: 12n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: 'b'.repeat(64),
      },
    });
    return document.id;
  }

  it('writes the step statuses and the page count of the canonical to the document row', async () => {
    const documentId = await givenLibraryDocument();
    pdfs.pageCount = 42;
    pdfs.defaultMarkdown = 'Long enough to read as a text layer over forty-two pages. '.repeat(60);

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.canonicalStatus).toBe('DONE');
    expect(row.previewStatus).toBe('DONE');
    expect(row.pageCount).toBe(42);
    expect(row.processingError).toBeNull();
    // 🔒 Every document has a canonical PDF, and the previews are rendered from it (ADR-021).
    expect(files.keys()).toEqual([
      artifactKeys.canonicalPdf(documentId),
      artifactKeys.preview(documentId),
      artifactKeys.thumbnail(documentId),
    ]);
  });

  it('caps a runaway error message instead of storing an HTML page in the column', async () => {
    const documentId = await givenLibraryDocument();
    // A sibling container answering with a full HTML error page is the realistic case.
    pdfs.failureDetail = '<html><body>Internal Server Error</body></html>'.repeat(200);
    pdfs.failOn('pdfPageJpg');

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.previewStatus).toBe('FAILED');
    expect(row.failedStep).toBe('preview');
    expect((row.processingError ?? '').length).toBe(2000);
    expect(row.processingError?.endsWith('…')).toBe(true);
  });

  it('finds the bytes of each file through its own live ref', async () => {
    const documentId = await givenLibraryDocument();

    await handler.handle({ documentId });

    expect(reader.opened).toContain(SOURCE_PATH);
  });

  it('reads a file in the order the document holds its pages, and keeps it across a reprocess', async () => {
    const documentId = await givenLibraryDocument();
    const file = await prisma.file.findFirstOrThrow({ where: { name: SOURCE_PATH } });
    pdfs.pageCount = 3;
    pdfs.defaultMarkdown = 'Long enough to read as a text layer over three pages. '.repeat(20);

    // The first build counts the pages and expands the entry standing for the file whole (ADR-025).
    await handler.handle({ documentId });
    expect(
      (
        await prisma.documentPage.findMany({ where: { documentId }, orderBy: { position: 'asc' } })
      ).map((page) => page.pageIndex),
    ).toEqual([0, 1, 2]);
    // The build counted the file's pages on its way past (docs/03 §3.3.16).
    expect((await prisma.file.findUniqueOrThrow({ where: { id: file.id } })).pageCount).toBe(3);

    // What a person dragged into place, written on the document's own list.
    const held = await fileRepo.listPagesForDocument(documentId);
    await fileRepo.replacePages(documentId, {
      pages: withFilePageOrder(held, file.id, [2, 0, 1]),
      expecting: null,
    });
    pdfs.calls.length = 0;
    await handler.handle({ documentId });
    expect(pdfs.calls).toContainEqual({ method: 'rearrangePages', fileName: '2,0,1' });

    // Every step again, from the top: the order is the document's, and nothing in the pipeline
    // rewrites it — so a reprocess obeys it exactly as the run before did (docs/05 §5.6).
    pdfs.calls.length = 0;
    await handler.handle({ documentId });

    const after = await fileRepo.listPagesForDocument(documentId);
    expect(after.map((page) => page.pageIndex)).toEqual([2, 0, 1]);
    expect(pdfs.calls).toContainEqual({ method: 'rearrangePages', fileName: '2,0,1' });
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
    pdfs.defaultMarkdown = 'Счёт за январь — 1 200 ₽ по договору оказания услуг за отчётный период';

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.markdown).toContain('Счёт за январь — 1 200 ₽');
  });

  it('writes chunks with their vectors into pgvector, replacing them wholesale on a re-run', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    pdfs.defaultMarkdown = 'The first body of this document, long enough to be worth embedding.';

    await handler.handle({ documentId });

    const first = await prisma.$queryRawUnsafe<
      { index: number; content: string; dims: number; model: string | null }[]
    >(
      `SELECT index, content, vector_dims(embedding) AS dims, model
       FROM document_chunks WHERE document_id = $1::uuid ORDER BY index`,
      documentId,
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.content).toContain('first body');
    expect(Number(first[0]?.dims)).toBe(EMBEDDING_WIDTH);
    // 🔒 And which model made it, beside it (docs/03 §3.3.11): two models in one table is a search
    // whose distances mean nothing, and nothing else in the row would say so.
    expect(first[0]?.model).toBe(embeddings.model);
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: documentId } })).vectorizationStatus,
    ).toBe('DONE');

    // A re-run with different text replaces the set rather than adding to it (docs/03 §3.3.11).
    pdfs.defaultMarkdown = 'A completely different body, with quite enough words to be a chunk.';
    await handler.handle({ documentId });

    const second = await prisma.$queryRawUnsafe<{ content: string }[]>(
      `SELECT content FROM document_chunks WHERE document_id = $1::uuid ORDER BY index`,
      documentId,
    );
    expect(second).toHaveLength(1);
    expect(second[0]?.content).toContain('completely different');
  });

  // 🔒 The regression of M58.1. Seventy-one documents on the live instance are FAILED here with
  // "the timeout for this transaction was 5000 ms, however 10085 ms passed": the write inherited
  // Prisma's default because nobody had chosen one for it. What the failures show is that the row
  // count is not what decides the wall clock — a sixteen-chunk write was refused after 94 seconds
  // while a nine-hundred-chunk one committed in 6 — so the test buys the same wall clock with a
  // sleep inside the transaction rather than by writing an unreproducible number of rows.
  it('writes the vectors of a document whose write outlasts the driver default', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    pdfs.defaultMarkdown = 'A body worth embedding, held open longer than five seconds.';
    chunks.holdMs = HOLD_PAST_DRIVER_DEFAULT_MS;

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.vectorizationStatus).toBe('DONE');
    expect(row.processingError).toBeNull();
    expect(await prisma.documentChunk.count({ where: { documentId } })).toBe(1);
  });

  // The insert is cut into batches (docs/03 §3.3.11) — a document long enough to need more than one
  // of them must land whole and in order, which is the only thing a reader can tell about the cut.
  it('writes every chunk of a document that outgrows one insert, in order', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    // Over 500 chunks at this suite's 200-character target: more than one statement carries.
    pdfs.defaultMarkdown = 'Paragraph about the archive and what it holds. '.repeat(2_800);

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.vectorizationStatus).toBe('DONE');
    expect(row.processingError).toBeNull();

    const written = await prisma.$queryRawUnsafe<{ index: number }[]>(
      `SELECT index FROM document_chunks WHERE document_id = $1::uuid ORDER BY index`,
      documentId,
    );
    expect(written.length).toBeGreaterThan(500);
    // No gap and no duplicate: every batch landed, and each landed once.
    expect(written.map((chunk) => chunk.index)).toEqual(written.map((_, index) => index));
  });

  it('finds a chunk by cosine distance, which is what semantic search will do', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    pdfs.defaultMarkdown = 'Searchable body text, long enough to survive the text-layer threshold.';

    await handler.handle({ documentId });

    // The same query the search use case will run (docs/04 §4.5): nearest neighbours by cosine.
    const query = `[${embeddingOf([0, 21]).join(',')}]`;
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
    // 🔒 The step runs over it all the same and simply does not write those two columns: the choice
    // travels into the call as a confirmed value instead of standing in front of it, so the
    // document still gets its date, its place and its description (docs/05 §5.5 step 4).
    expect(after.analysisStatus).toBe('DONE');
    expect(after.skipReasons).not.toHaveProperty('analysis');
  });

  it('skips both AI steps, without error, when no provider is configured', async () => {
    const documentId = await givenLibraryDocument('text/plain');
    analyst.configured = false;
    embeddings.configured = false;

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.analysisStatus).toBe('SKIPPED');
    expect(row.vectorizationStatus).toBe('SKIPPED');
    expect(row.processingError).toBeNull();
    expect(await prisma.documentChunk.count({ where: { documentId } })).toBe(0);
  });

  it('leaves a document nothing can render settled, without any artifact', async () => {
    await prisma.documentType.create({ data: { slug: 'other', name: 'Other' } });
    const documentId = await givenLibraryDocument('application/x-executable');

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.canonicalStatus).toBe('SKIPPED');
    expect(row.previewStatus).toBe('SKIPPED');
    expect(row.markdownStatus).toBe('SKIPPED');
    expect(row.vectorizationStatus).toBe('SKIPPED');
    // Nothing is left PENDING: the document is finished, not forever in progress — and the two
    // steps that read the extraction inherit the reason it recorded (docs/05 §5.5).
    expect(row.analysisStatus).toBe('SKIPPED');
    // And the reason is on the row, so the panel can say why rather than only that (docs/03 §3.3.10).
    expect(row.skipReasons).toMatchObject({
      canonical: 'UNSUPPORTED_FORMAT',
      analysis: 'UNSUPPORTED_FORMAT',
      vectorization: 'UNSUPPORTED_FORMAT',
    });
    expect(files.keys()).toEqual([]);
  });

  it('builds one canonical out of several files, in position order', async () => {
    const documentId = await givenLibraryDocument();
    const second = await prisma.file.create({
      data: {
        contentHash: 'c'.repeat(64),
        origin: 'LIBRARY',
        mimeType: 'application/pdf',
        ext: 'pdf',
        sizeBytes: 12n,
        name: 'b.pdf',
      },
    });
    await prisma.documentPage.create({
      data: { documentId, position: 1, fileId: second.id, pageIndex: null },
    });
    const library = await prisma.library.findFirstOrThrow();
    await prisma.fileRef.create({
      data: {
        libraryId: library.id,
        fileId: second.id,
        path: 'b.pdf',
        size: 12n,
        mtime: new Date('2026-01-01T00:00:00.000Z'),
        status: 'HASHED',
        contentHash: 'c'.repeat(64),
      },
    });
    reader.put('b.pdf', 'second-bytes');

    await handler.handle({ documentId });

    const row = await prisma.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.canonicalStatus).toBe('DONE');
    // 🔒 Page order is position order (docs/05 §5.5 step 1).
    expect(files.get(artifactKeys.canonicalPdf(documentId)).body.toString()).toBe(
      'merged(source-bytes,second-bytes)',
    );
  });
});

// The real chunk repository with a tap on it: `holdMs` keeps the transaction the write runs in open
// for that long before any row is written. A dev container cannot reproduce what makes this write
// slow on the live instance — the same process converting, OCR-ing and parsing other documents
// against a database on its own host — and a test that tried to buy the time with rows would be a
// test about how fast the machine running it is. The sleep runs on the handle the caller was given,
// so it is genuinely inside the transaction and not beside it.
class SlowChunkRepository extends DocumentChunkRepository {
  holdMs = 0;

  constructor(private readonly inner: DocumentChunkRepository) {
    super();
  }

  async replaceForDocument(
    documentId: string,
    chunks: readonly NewDocumentChunk[],
    tx?: TransactionHandle,
  ): Promise<void> {
    if (this.holdMs > 0) {
      if (!isPrismaTx(tx))
        throw new Error('The chunk write is expected to run inside a transaction');
      await tx.$executeRawUnsafe(`SELECT pg_sleep(${(this.holdMs / 1000).toFixed(3)})`);
    }
    await this.inner.replaceForDocument(documentId, chunks, tx);
  }

  countForDocument(documentId: string, tx?: TransactionHandle): Promise<number> {
    return this.inner.countForDocument(documentId, tx);
  }

  countByModel(tx?: TransactionHandle): Promise<Array<{ model: string | null; chunks: number }>> {
    return this.inner.countByModel(tx);
  }
}
