import { Readable } from 'node:stream';
import type { Document, DocumentSteps } from '../../src/server/domain/entities/document';
import { pendingSteps } from '../../src/server/domain/entities/document';
import type { FileRef } from '../../src/server/domain/entities/file-ref';
import type { Library } from '../../src/server/domain/entities/library';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentUpsert,
  type ProcessingUpdate,
  type DocumentDetail,
  type DocumentPage,
  type StepStatusCounters,
} from '../../src/server/domain/repositories/document.repository';
import {
  FileRefRepository,
  type CreateFileRefInput,
  type FileRefSnapshot,
  type FolderSummary,
} from '../../src/server/domain/repositories/file-ref.repository';
import {
  LibraryRepository,
  type CreateLibraryInput,
  type LibraryCounts,
  type UpdateLibraryInput,
} from '../../src/server/domain/repositories/library.repository';
import { RelativePath } from '../../src/server/domain/value-objects/relative-path';
import type { BinarySource } from '../../src/server/application/ports/binary-source';
import { ImageTool, type JpegPreviewOptions } from '../../src/server/application/ports/image-tool';
import {
  LibraryReader,
  type FsDirectoryEntry,
  type FsEntry,
  type LibraryLocation,
  type WalkResult,
} from '../../src/server/application/ports/library-reader';
import {
  PdfToolbox,
  type FirstPageOptions,
  type NamedBinary,
} from '../../src/server/application/ports/pdf-toolbox';
import { TextExtractor } from '../../src/server/application/ports/text-extractor';
import {
  DocumentClassifier,
  type CategoryOption,
} from '../../src/server/application/ports/document-classifier';
import { EmbeddingProvider } from '../../src/server/application/ports/embedding-provider';
import {
  UnitOfWork,
  type TransactionHandle,
} from '../../src/server/application/ports/unit-of-work';
import {
  CategoryRepository,
  type Category,
  type CategoryWithCount,
} from '../../src/server/domain/repositories/category.repository';
import {
  DocumentChunkRepository,
  type NewDocumentChunk,
} from '../../src/server/domain/repositories/document-chunk.repository';

// In-memory doubles for the processing pipeline (docs/14 §14.8). The repositories keep only the
// behaviour the pipeline depends on; anything a handler never calls throws instead of pretending.

function unused(name: string): never {
  throw new Error(`${name} is not part of the processing pipeline`);
}

// Payloads carry ids as uuids, so fixtures do too.
export const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
export const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';

export function documentFixture(overrides: Partial<Document> = {}): Document {
  return {
    id: DOCUMENT_ID,
    contentHash: 'a'.repeat(64),
    source: 'LIBRARY',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: 1024n,
    pageCount: null,
    title: 'Invoice 2026-01',
    markdown: null,
    steps: pendingSteps(),
    processingError: null,
    failedStep: null,
    ocrUsed: false,
    categoryId: null,
    categorySource: 'NONE',
    createdById: null,
    scanSetId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

export class InMemoryDocumentRepository extends DocumentRepository {
  readonly documents = new Map<string, Document>();
  // Every update in order, so a test can assert what the admin panel would have shown while the
  // pipeline ran — not just the final row.
  readonly updates: Array<{ id: string; update: ProcessingUpdate }> = [];

  add(document: Document): Document {
    this.documents.set(document.id, document);
    return document;
  }

  findById(id: string): Promise<Document | null> {
    return Promise.resolve(this.documents.get(id) ?? null);
  }

  updateProcessing(id: string, update: ProcessingUpdate): Promise<Document> {
    const existing = this.documents.get(id);
    if (existing === undefined) throw new Error(`No document ${id}`);
    this.updates.push({ id, update });

    const steps: DocumentSteps = { ...existing.steps, ...(update.steps ?? {}) };
    const updated: Document = {
      ...existing,
      steps,
      ...(update.pageCount === undefined ? {} : { pageCount: update.pageCount }),
      ...(update.markdown === undefined ? {} : { markdown: update.markdown }),
      ...(update.ocrUsed === undefined ? {} : { ocrUsed: update.ocrUsed }),
      ...(update.processingError === undefined ? {} : { processingError: update.processingError }),
      ...(update.failedStep === undefined ? {} : { failedStep: update.failedStep }),
      ...(update.categoryId === undefined ? {} : { categoryId: update.categoryId }),
      ...(update.categorySource === undefined ? {} : { categorySource: update.categorySource }),
    };
    this.documents.set(id, updated);
    return Promise.resolve(updated);
  }

  findActiveByContentHash(contentHash: string): Promise<Document | null> {
    return Promise.resolve(
      [...this.documents.values()].find(
        (document) => document.contentHash === contentHash && document.deletedAt === null,
      ) ?? null,
    );
  }

  findOrCreateByContentHash(_input: CreateDocumentInput): Promise<DocumentUpsert> {
    return unused('findOrCreateByContentHash');
  }

  countByStepStatus(): Promise<StepStatusCounters> {
    return unused('countByStepStatus');
  }
  listReadable(): Promise<DocumentPage> {
    return unused('listReadable');
  }
  findReadableById(): Promise<DocumentDetail | null> {
    return unused('findReadableById');
  }
  listInFolder(): Promise<DocumentPage> {
    return unused('listInFolder');
  }
  updateMeta(): Promise<Document> {
    return unused('updateMeta');
  }
  softDelete(): Promise<void> {
    return unused('softDelete');
  }
}

export class InMemoryFileRefRepository extends FileRefRepository {
  readonly refs: FileRef[] = [];

  add(ref: Partial<FileRef> & Pick<FileRef, 'id' | 'libraryId' | 'documentId'>): FileRef {
    const full: FileRef = {
      path: RelativePath.parse('invoices/a.pdf'),
      size: 1024n,
      mtimeMs: 0,
      status: 'HASHED',
      contentHash: 'a'.repeat(64),
      missingSince: null,
      firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
      ...ref,
    };
    this.refs.push(full);
    return full;
  }

  findById(id: string): Promise<FileRef | null> {
    return Promise.resolve(this.refs.find((ref) => ref.id === id) ?? null);
  }

  findLiveRefForDocument(documentId: string): Promise<FileRef | null> {
    return Promise.resolve(
      this.refs.find((ref) => ref.documentId === documentId && ref.status === 'HASHED') ?? null,
    );
  }

  countLiveRefsInActiveLibraries(documentId: string): Promise<number> {
    return Promise.resolve(
      this.refs.filter((ref) => ref.documentId === documentId && ref.status === 'HASHED').length,
    );
  }

  findByPath(): Promise<FileRef | null> {
    return unused('findByPath');
  }
  listFoldersUnder(): Promise<FolderSummary[]> {
    return unused('listFoldersUnder');
  }
  snapshotForLibrary(): Promise<FileRefSnapshot[]> {
    return unused('snapshotForLibrary');
  }
  create(_input: CreateFileRefInput): Promise<FileRef> {
    return unused('create');
  }
  markDiscovered(): Promise<void> {
    return unused('markDiscovered');
  }
  markHashed(): Promise<void> {
    return unused('markHashed');
  }
  touchSeen(): Promise<void> {
    return unused('touchSeen');
  }
  markMissing(): Promise<number> {
    return unused('markMissing');
  }
}

export function libraryFixture(overrides: Partial<Library> = {}): Library {
  return {
    id: LIBRARY_ID,
    name: 'Invoices',
    rootPath: RelativePath.parse('invoices'),
    enabled: true,
    visibility: 'ALL_USERS',
    scanIntervalMinutes: 15,
    excludeGlobs: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

export class InMemoryLibraryRepository extends LibraryRepository {
  readonly libraries: Library[] = [];

  add(library: Library): Library {
    this.libraries.push(library);
    return library;
  }

  findById(id: string): Promise<Library | null> {
    return Promise.resolve(this.libraries.find((library) => library.id === id) ?? null);
  }

  listActive(): Promise<Library[]> {
    return Promise.resolve(this.libraries.filter((library) => library.deletedAt === null));
  }

  listVisibleTo(): Promise<Library[]> {
    return unused('listVisibleTo');
  }
  create(_input: CreateLibraryInput): Promise<Library> {
    return unused('create');
  }
  update(_id: string, _input: UpdateLibraryInput): Promise<Library> {
    return unused('update');
  }
  softDelete(): Promise<void> {
    return unused('softDelete');
  }
  countsFor(): Promise<LibraryCounts[]> {
    return unused('countsFor');
  }
  listUserIds(): Promise<string[]> {
    return unused('listUserIds');
  }
  replaceUserIds(): Promise<void> {
    return unused('replaceUserIds');
  }
}

// A library volume held in memory: path → bytes. Opening the same path twice yields two streams,
// which is what the pipeline does when it reads a file for both page count and rendering.
export class StubLibraryReader extends LibraryReader {
  readonly files = new Map<string, Buffer>();
  opened: string[] = [];

  put(path: string, bytes: Buffer | string): void {
    this.files.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  }

  openStream(_library: LibraryLocation, relPath: RelativePath): Promise<Readable> {
    const bytes = this.files.get(relPath.value);
    if (bytes === undefined) return Promise.reject(new Error(`ENOENT: ${relPath.value}`));
    this.opened.push(relPath.value);
    return Promise.resolve(Readable.from(bytes));
  }

  stat(): Promise<FsEntry | null> {
    return unused('stat');
  }
  list(): Promise<FsDirectoryEntry[]> {
    return unused('list');
  }
  walk(): WalkResult {
    return unused('walk');
  }
  isDirectory(): Promise<boolean> {
    return unused('isDirectory');
  }
}

export type PdfToolboxCall = { method: string; fileName?: string };

// Records what the pipeline asked of the container, and can be told to fail a given call.
export class FakePdfToolbox extends PdfToolbox {
  readonly calls: PdfToolboxCall[] = [];
  failures = new Set<string>();
  pageCount = 1;
  // Appended to the failure message: the sibling containers answer with their own bodies, which can
  // be an entire HTML error page.
  failureDetail = '';

  failOn(method: string): void {
    this.failures.add(method);
  }

  private check(method: string, fileName?: string): void {
    this.calls.push(fileName === undefined ? { method } : { method, fileName });
    if (this.failures.has(method)) {
      const detail = this.failureDetail === '' ? '' : `: ${this.failureDetail}`;
      throw new Error(`Stirling ${method} failed with 500${detail}`);
    }
  }

  officeToPdf(source: NamedBinary): Promise<Buffer> {
    this.check('officeToPdf', source.fileName);
    return Promise.resolve(Buffer.from('canonical-pdf'));
  }

  pdfFirstPageJpg(_source: BinarySource, _options?: FirstPageOptions): Promise<Buffer> {
    this.check('pdfFirstPageJpg');
    return Promise.resolve(Buffer.from('rendered-page'));
  }

  ocrPdf(): Promise<Buffer> {
    this.check('ocrPdf');
    return Promise.resolve(Buffer.from('ocr-pdf'));
  }

  imagesToPdf(images: readonly NamedBinary[]): Promise<Buffer> {
    // The names are the interesting part: page order is item order (docs/05 §5.6).
    this.check('imagesToPdf', images.map((image) => image.fileName).join(','));
    return Promise.resolve(Buffer.from('merged-pdf'));
  }

  pdfPageCount(): Promise<number> {
    this.check('pdfPageCount');
    return Promise.resolve(this.pageCount);
  }
}

export type ResizeCall = { maxDim: number; quality: number | undefined; input: string };

// Reports the resize requests rather than doing image work: the pipeline's job is to ask for the
// configured dimensions, and sharp itself is covered by its own tests.
export class FakeImageTool extends ImageTool {
  readonly resizes: ResizeCall[] = [];
  failing = false;

  async toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer> {
    const input = await describe(source);
    this.resizes.push({ maxDim: options.maxDim, quality: options.quality, input });
    if (this.failing) throw new Error('sharp: unsupported image format');
    return Buffer.from(`jpeg:${options.maxDim}:${input}`);
  }

  trim(): Promise<Buffer> {
    return unused('trim');
  }
}

async function describe(source: BinarySource): Promise<string> {
  if (Buffer.isBuffer(source)) return source.toString();
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString();
}

// Returns whatever text the test says the PDF in front of it holds, keyed by the bytes it receives,
// so the OCR branch can be told apart from the text-layer one.
export class FakeTextExtractor extends TextExtractor {
  readonly reads: string[] = [];
  // Text layer of anything not listed in `byContent`.
  defaultPages: string[] = [];
  readonly byContent = new Map<string, string[]>();
  failing = false;

  async pdfTextByPage(source: BinarySource): Promise<string[]> {
    const content = await describe(source);
    this.reads.push(content);
    if (this.failing) throw new Error('pdfjs: invalid PDF structure');
    return this.byContent.get(content) ?? this.defaultPages;
  }
}

// The categories the classifier is offered (docs/03 §3.3.12).
export class InMemoryCategoryRepository extends CategoryRepository {
  readonly categories: Category[] = [];

  add(slug: string, description: string | null = null): Category {
    const category: Category = {
      id: `category-${this.categories.length + 1}`,
      slug,
      name: slug,
      description,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    this.categories.push(category);
    return category;
  }

  listActive(): Promise<Category[]> {
    return Promise.resolve(this.categories.filter((category) => category.deletedAt === null));
  }

  listActiveWithCounts(): Promise<CategoryWithCount[]> {
    return unused('listActiveWithCounts');
  }
  findById(id: string): Promise<Category | null> {
    return Promise.resolve(this.categories.find((category) => category.id === id) ?? null);
  }
  findActiveBySlug(slug: string): Promise<Category | null> {
    return Promise.resolve(this.categories.find((category) => category.slug === slug) ?? null);
  }
  create(): Promise<Category> {
    return unused('create');
  }
  update(): Promise<Category> {
    return unused('update');
  }
  softDelete(): Promise<void> {
    return unused('softDelete');
  }
  clearCategoryFromDocuments(): Promise<number> {
    return unused('clearCategoryFromDocuments');
  }
}

export class InMemoryDocumentChunkRepository extends DocumentChunkRepository {
  readonly byDocument = new Map<string, NewDocumentChunk[]>();
  // How many times a document's set was replaced, so a test can tell one wholesale write from two.
  replacements = 0;

  replaceForDocument(documentId: string, chunks: readonly NewDocumentChunk[]): Promise<void> {
    this.replacements += 1;
    this.byDocument.set(documentId, [...chunks]);
    return Promise.resolve();
  }

  countForDocument(documentId: string): Promise<number> {
    return Promise.resolve((this.byDocument.get(documentId) ?? []).length);
  }

  chunksOf(documentId: string): NewDocumentChunk[] {
    return this.byDocument.get(documentId) ?? [];
  }
}

// Runs the body without a real transaction; the handle is never inspected by the fakes.
export class ImmediateUnitOfWork extends UnitOfWork {
  run<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    return fn({});
  }
}

export class FakeClassifier extends DocumentClassifier {
  configured = true;
  answer: string | null = null;
  failing = false;
  readonly calls: Array<{ excerpt: string; categories: readonly CategoryOption[] }> = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  classify(excerpt: string, categories: readonly CategoryOption[]): Promise<string | null> {
    this.calls.push({ excerpt, categories });
    if (this.failing) return Promise.reject(new Error('Classifier request failed with 503'));
    return Promise.resolve(this.answer);
  }
}

export class FakeEmbeddingProvider extends EmbeddingProvider {
  configured = true;
  failing = false;
  // Vectors are padded to this width; the real column is vector(1536), so anything writing to a
  // database has to say so (docs/04 §4.3).
  dimensions = 3;
  readonly batches: string[][] = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    if (this.failing) return Promise.reject(new Error('Embeddings request failed with 500'));
    // Distinguishable per chunk: position and length, then zeros.
    return Promise.resolve(
      texts.map((text, index) =>
        Array.from({ length: this.dimensions }, (_, position) =>
          position === 0 ? index : position === 1 ? text.length : 0,
        ),
      ),
    );
  }
}
