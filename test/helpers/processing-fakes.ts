import { Readable } from 'node:stream';
import {
  DocumentParser,
  type ParseOptions,
} from '../../src/server/application/ports/document-parser';
import type { Document, DocumentSteps } from '../../src/server/domain/entities/document';
import { pendingSteps } from '../../src/server/domain/entities/document';
import type { FileRef } from '../../src/server/domain/entities/file-ref';
import type { File } from '../../src/server/domain/entities/file';
import type { Library } from '../../src/server/domain/entities/library';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type ProcessingUpdate,
  type DocumentDetail,
  type DocumentPage,
  type SearchMatch,
  type StepStatusCounters,
} from '../../src/server/domain/repositories/document.repository';
import {
  FileRepository,
  type CreateFileInput,
  type DocumentFile,
} from '../../src/server/domain/repositories/file.repository';
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
import type { Crop } from '../../src/shared/contracts/documents';
import { toBuffer, type BinarySource } from '../../src/server/application/ports/binary-source';
import { ImageTool, type JpegPreviewOptions } from '../../src/server/application/ports/image-tool';
import type { GrayscaleRaster } from '../../src/server/domain/entities/page-detection';
import { QueueSettings } from '../../src/server/application/queue/queue-settings';
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
  type PdfMetadata,
} from '../../src/server/application/ports/pdf-toolbox';
import {
  DocumentAnalyst,
  type DocumentTypeOption,
  type DocumentAnalysis,
} from '../../src/server/application/ports/document-analyst';
import { EmbeddingProvider } from '../../src/server/application/ports/embedding-provider';
import { CallContext } from '../../src/server/application/ports/call-context';
import type { Person } from '../../src/server/domain/entities/person';
import {
  SettingsRepository,
  type SettingValue,
} from '../../src/server/domain/repositories/settings.repository';
import type { Subject } from '../../src/server/domain/entities/subject';
import type { SubjectKind } from '../../src/server/domain/entities/subject-kind';
import {
  SubjectKindRepository,
  type SubjectKindWithCounts,
} from '../../src/server/domain/repositories/subject-kind.repository';
import {
  SubjectRepository,
  type SubjectWithCount,
} from '../../src/server/domain/repositories/subject.repository';
import {
  PersonRepository,
  type PersonWithCount,
} from '../../src/server/domain/repositories/person.repository';
import {
  DocumentEventRepository,
  type DocumentEventView,
  type NewDocumentEvent,
} from '../../src/server/domain/repositories/document-event.repository';
import {
  UnitOfWork,
  type TransactionHandle,
} from '../../src/server/application/ports/unit-of-work';
import {
  DocumentTypeRepository,
  type DocumentType,
  type DocumentTypeWithCount,
} from '../../src/server/domain/repositories/document-type.repository';
import {
  DocumentChunkRepository,
  type NewDocumentChunk,
} from '../../src/server/domain/repositories/document-chunk.repository';

// In-memory doubles for the processing pipeline (docs/14 §14.8). The repositories keep only the
// behaviour the pipeline depends on; anything a handler never calls throws instead of pretending.

function unused(name: string): never {
  throw new Error(`${name} is not part of the processing pipeline`);
}

// The keys of DocumentSteps, which is what a skip reason is filed under.
function stepKey(step: string): keyof DocumentSteps {
  const known: Array<keyof DocumentSteps> = [
    'canonical',
    'preview',
    'markdown',
    'analysis',
    'vectorization',
  ];
  const found = known.find((candidate) => candidate === step);
  if (found === undefined) throw new Error(`Unknown pipeline step ${step}`);
  return found;
}

// Payloads carry ids as uuids, so fixtures do too.
export const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
export const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';

export const FILE_ID = '55555555-5555-4555-8555-555555555555';

export function documentFixture(overrides: Partial<Document> = {}): Document {
  return {
    id: DOCUMENT_ID,
    description: null,
    titleSource: 'NONE',
    pageCount: null,
    title: 'Invoice 2026-01',
    markdown: null,
    steps: pendingSteps(),
    processingError: null,
    failedStep: null,
    skipReasons: {},
    auto: {},
    documentDate: null,
    languages: [],
    country: null,
    city: null,
    ocrUsed: false,
    typeId: null,
    typeSource: 'NONE',
    createdById: null,
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
  private created = 0;

  add(document: Document): Document {
    this.documents.set(document.id, document);
    return document;
  }

  findById(id: string): Promise<Document | null> {
    return Promise.resolve(this.documents.get(id) ?? null);
  }

  // A document is created empty and given its files afterwards (docs/03 §3.3.17).
  create(input: CreateDocumentInput): Promise<Document> {
    this.created += 1;
    return Promise.resolve(
      this.add(
        documentFixture({
          id: `created-${this.created}`,
          title: input.title,
          createdById: input.createdById ?? null,
          pageCount: null,
          markdown: null,
          steps: pendingSteps(),
        }),
      ),
    );
  }

  updateProcessing(id: string, update: ProcessingUpdate): Promise<Document> {
    const existing = this.documents.get(id);
    if (existing === undefined) throw new Error(`No document ${id}`);
    this.updates.push({ id, update });

    const steps: DocumentSteps = { ...existing.steps, ...(update.steps ?? {}) };
    // Merged one step at a time, and a null clears that step's note — what the column does.
    const skipReasons = { ...existing.skipReasons };
    for (const [step, reason] of Object.entries(update.skipReasons ?? {})) {
      if (reason === null) delete skipReasons[stepKey(step)];
      else skipReasons[stepKey(step)] = reason;
    }

    const updated: Document = {
      ...existing,
      steps,
      skipReasons,
      ...(update.pageCount === undefined ? {} : { pageCount: update.pageCount }),
      ...(update.languages === undefined ? {} : { languages: update.languages }),
      // Merged, like the column: each step adds what it worked out (docs/03 §3.3.10).
      ...(update.auto === undefined ? {} : { auto: { ...existing.auto, ...update.auto } }),
      ...(update.documentDate === undefined ? {} : { documentDate: update.documentDate }),
      ...(update.country === undefined ? {} : { country: update.country }),
      ...(update.city === undefined ? {} : { city: update.city }),
      ...(update.markdown === undefined ? {} : { markdown: update.markdown }),
      ...(update.ocrUsed === undefined ? {} : { ocrUsed: update.ocrUsed }),
      ...(update.processingError === undefined ? {} : { processingError: update.processingError }),
      ...(update.failedStep === undefined ? {} : { failedStep: update.failedStep }),
      ...(update.typeId === undefined ? {} : { typeId: update.typeId }),
      ...(update.typeSource === undefined ? {} : { typeSource: update.typeSource }),
      ...(update.title === undefined ? {} : { title: update.title }),
      ...(update.titleSource === undefined ? {} : { titleSource: update.titleSource }),
      ...(update.description === undefined ? {} : { description: update.description }),
    };
    this.documents.set(id, updated);
    return Promise.resolve(updated);
  }

  filterExistingIds(ids: string[]): Promise<string[]> {
    return Promise.resolve(ids.filter((id) => this.documents.has(id)));
  }

  listYears(): Promise<Array<{ year: number; count: number }>> {
    return unused('listYears');
  }

  readonly updatedAt = new Map<string, Date>();

  setUpdatedAt(documentId: string, at: Date): void {
    this.updatedAt.set(documentId, at);
  }

  listStalePendingIds(olderThan: Date, limit: number): Promise<string[]> {
    // `updatedAt` is a column, not part of the domain entity, so the fake keeps its own note of
    // when a row was last written and the test drives it through `setUpdatedAt`.
    const stale = [...this.documents.values()].filter(
      (document: Document) =>
        document.deletedAt === null &&
        (this.updatedAt.get(document.id) ?? document.createdAt).getTime() < olderThan.getTime() &&
        Object.values(document.steps).some((status) => status === 'PENDING'),
    );
    return Promise.resolve(stale.slice(0, limit).map((document: Document) => document.id));
  }

  countByStepStatus(): Promise<StepStatusCounters> {
    return unused('countByStepStatus');
  }
  listReadable(): Promise<DocumentPage> {
    return unused('listReadable');
  }
  // Whatever a test puts here decides what the viewer may read; absent means "not readable".
  readable = new Map<string, DocumentDetail>();

  findReadableById(id: string): Promise<DocumentDetail | null> {
    return Promise.resolve(this.readable.get(id) ?? null);
  }
  listInFolder(): Promise<DocumentPage> {
    return unused('listInFolder');
  }
  listInCollection(): Promise<DocumentPage> {
    return unused('listInCollection');
  }
  searchByText(): Promise<SearchMatch[]> {
    return unused('searchByText');
  }
  searchByVector(): Promise<SearchMatch[]> {
    return unused('searchByVector');
  }
  updateMeta(): Promise<Document> {
    return unused('updateMeta');
  }
  softDelete(id: string, deletedAt: Date): Promise<void> {
    const document = this.documents.get(id);
    if (document !== undefined) this.documents.set(id, { ...document, deletedAt });
    return Promise.resolve();
  }
}

export function fileFixture(overrides: Partial<File> = {}): File {
  return {
    id: FILE_ID,
    contentHash: 'a'.repeat(64),
    origin: 'LIBRARY',
    storageKey: null,
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: 1024n,
    name: 'a.pdf',
    crop: null,
    cropSource: 'NONE',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

// The bytes, once, and which document holds them in what order (docs/03 §3.3.16–3.3.17). The map of
// homes is the join table: a file has exactly one, and the fake enforces that as the schema does.
export class InMemoryFileRepository extends FileRepository {
  readonly files = new Map<string, File>();
  // documentId → fileIds in position order.
  readonly composition = new Map<string, string[]>();
  private created = 0;

  // Adds a file and, unless told otherwise, gives it a home — which is what every file has.
  add(file: Partial<File> = {}, documentId: string | null = DOCUMENT_ID): File {
    const full = fileFixture({ id: file.id ?? `file-${this.files.size + 1}`, ...file });
    this.files.set(full.id, full);
    if (documentId !== null)
      this.composition.set(documentId, [...(this.composition.get(documentId) ?? []), full.id]);
    return full;
  }

  findById(id: string): Promise<File | null> {
    return Promise.resolve(this.files.get(id) ?? null);
  }

  findActiveByContentHash(contentHash: string): Promise<File | null> {
    return Promise.resolve(
      [...this.files.values()].find(
        (file) => file.contentHash === contentHash && file.deletedAt === null,
      ) ?? null,
    );
  }

  findOrCreateByContentHash(input: CreateFileInput): Promise<{ file: File; created: boolean }> {
    const existing = [...this.files.values()].find(
      (file) => file.contentHash === input.contentHash && file.deletedAt === null,
    );
    if (existing !== undefined) return Promise.resolve({ file: existing, created: false });

    this.created += 1;
    const file = fileFixture({ ...input, id: `file-created-${this.created}` });
    this.files.set(file.id, file);
    return Promise.resolve({ file, created: true });
  }

  setCrop(id: string, crop: Crop | null, cropSource: File['cropSource']): Promise<File> {
    const file = this.files.get(id);
    if (file === undefined) throw new Error(`No file ${id}`);
    const updated = { ...file, crop, cropSource };
    this.files.set(id, updated);
    return Promise.resolve(updated);
  }

  softDelete(id: string, deletedAt: Date): Promise<void> {
    const file = this.files.get(id);
    if (file !== undefined) this.files.set(id, { ...file, deletedAt });
    return Promise.resolve();
  }

  listForDocument(documentId: string): Promise<DocumentFile[]> {
    const ids = this.composition.get(documentId) ?? [];
    return Promise.resolve(
      ids.flatMap((id, position) => {
        const file = this.files.get(id);
        return file === undefined ? [] : [{ ...file, position }];
      }),
    );
  }

  async listForDocuments(documentIds: readonly string[]): Promise<Map<string, DocumentFile[]>> {
    const out = new Map<string, DocumentFile[]>();
    for (const documentId of documentIds) {
      out.set(documentId, await this.listForDocument(documentId));
    }
    return out;
  }

  findDocumentIdForFile(fileId: string): Promise<string | null> {
    for (const [documentId, ids] of this.composition) {
      if (ids.includes(fileId)) return Promise.resolve(documentId);
    }
    return Promise.resolve(null);
  }

  attach(documentId: string, fileId: string): Promise<void> {
    this.composition.set(documentId, [...(this.composition.get(documentId) ?? []), fileId]);
    return Promise.resolve();
  }

  detach(documentId: string, fileId: string): Promise<void> {
    this.composition.set(
      documentId,
      (this.composition.get(documentId) ?? []).filter((id) => id !== fileId),
    );
    return Promise.resolve();
  }

  reorder(documentId: string, fileIdsInOrder: readonly string[]): Promise<void> {
    this.composition.set(documentId, [...fileIdsInOrder]);
    return Promise.resolve();
  }

  countLiveRefsForFiles(fileIds: readonly string[]): Promise<Map<string, number>> {
    return Promise.resolve(new Map(fileIds.map((id) => [id, 1])));
  }
}

export class InMemoryFileRefRepository extends FileRefRepository {
  readonly refs: FileRef[] = [];

  add(ref: Partial<FileRef> & Pick<FileRef, 'id' | 'libraryId' | 'fileId'>): FileRef {
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

  // Where a file's bytes can be read: a file is asked, not a document, because a document is many
  // files and each has its own homes (docs/05 §5.3).
  findLiveRefForFile(fileId: string): Promise<FileRef | null> {
    return Promise.resolve(
      this.refs.find((ref) => ref.fileId === fileId && ref.status === 'HASHED') ?? null,
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
  // Ingest finished: the ref now points at the file its bytes are (docs/05 §5.3).
  markHashed(
    id: string,
    contentHash: string,
    fileId: string,
    size: bigint,
    mtimeMs: number,
  ): Promise<void> {
    const index = this.refs.findIndex((ref) => ref.id === id);
    const ref = this.refs[index];
    if (ref === undefined) throw new Error(`No file ref ${id}`);
    this.refs[index] = {
      ...ref,
      status: 'HASHED',
      contentHash,
      fileId,
      size,
      mtimeMs,
      missingSince: null,
    };
    return Promise.resolve();
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
  readonly endpoint = 'http://stirling.test';
  readonly calls: PdfToolboxCall[] = [];
  // What the metadata pass was told the document is (docs/05 §5.5 step 1).
  readonly stamped: PdfMetadata[] = [];
  failures = new Set<string>();
  pageCount = 1;

  // Text extraction lives on this port now (docs/06 §6.3.3): one Stirling client, one fake.
  readonly markdownReads: string[] = [];
  defaultMarkdown = '';
  readonly markdownByContent = new Map<string, string>();
  markdownFailing = false;
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

  toPdf(source: NamedBinary): Promise<Buffer> {
    this.check('toPdf', source.fileName);
    return Promise.resolve(Buffer.from('converted-pdf'));
  }

  pdfFirstPageJpg(_source: BinarySource, _options?: FirstPageOptions): Promise<Buffer> {
    this.check('pdfFirstPageJpg');
    return Promise.resolve(Buffer.from('rendered-page'));
  }

  // What each OCR pass was asked to recognise: a wrong set costs accuracy, so the pipeline's choice
  // of languages is worth asserting on (docs/03 §3.3.10).
  readonly ocrLanguages: string[][] = [];

  ocrPdf(_source: BinarySource, languages: readonly string[]): Promise<Buffer> {
    this.check('ocrPdf');
    this.ocrLanguages.push([...languages]);
    return Promise.resolve(Buffer.from('ocr-pdf'));
  }

  async pdfToMarkdown(source: BinarySource): Promise<string> {
    const content = await describe(source);
    this.markdownReads.push(content);
    this.check('pdfToMarkdown');
    if (this.markdownFailing) throw new Error('Stirling pdfToMarkdown failed with 500');
    return this.markdownByContent.get(content) ?? this.defaultMarkdown;
  }

  async imagesToPdf(images: readonly NamedBinary[]): Promise<Buffer> {
    // The names are the interesting part: page order is item order (docs/05 §5.5 step 1).
    this.check('imagesToPdf', images.map((image) => image.fileName).join(','));
    // Carries what it was given, so a test can follow one page's bytes into the canonical.
    const bodies = await Promise.all(images.map((image) => describe(image.body)));
    return Buffer.from(`image-pdf(${bodies.join(',')})`);
  }

  // The parts of a document, in position order (docs/05 §5.5 step 1). The result names them, so a
  // reordered merge is visible in an assertion rather than only in a person's document.
  async mergePdfs(parts: readonly BinarySource[]): Promise<Buffer> {
    const bodies = await Promise.all(parts.map((part) => describe(part)));
    this.check('mergePdfs', bodies.join(','));
    return Buffer.from(`merged(${bodies.join(',')})`);
  }

  // Best-effort by contract: a test makes this fail to prove the canonical survives it. The bytes
  // come back unchanged, so what a later step reads is still the PDF the merge produced; what was
  // stamped is recorded instead.
  async stampMetadata(source: BinarySource, metadata: PdfMetadata): Promise<Buffer> {
    this.check('stampMetadata', metadata.title);
    this.stamped.push(metadata);
    return toBuffer(source);
  }

  pdfPageCount(): Promise<number> {
    this.check('pdfPageCount');
    return Promise.resolve(this.pageCount);
  }
}

export type ResizeCall = { maxDim: number; quality: number | undefined; input: string };

// Reports the resize requests rather than doing image work: the pipeline's job is to ask for the
// configured dimensions, and sharp itself is covered by its own tests.
// Not configured by default: the suites that predate Docling describe the fallback path, and the
// ones that care set `configured` and read `calls`.
export class FakeDocumentParser extends DocumentParser {
  readonly endpoint = 'http://docling.test';
  configured = false;
  markdown = '';
  failing = false;
  readonly calls: Array<{ ocrLanguages: readonly string[] }> = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  toMarkdown(_source: BinarySource, options: ParseOptions): Promise<string> {
    this.calls.push({ ocrLanguages: options.ocrLanguages });
    if (this.failing) return Promise.reject(new Error('Docling toMarkdown failed with 500'));
    return Promise.resolve(this.markdown);
  }
}

export class FakeImageTool extends ImageTool {
  readonly resizes: ResizeCall[] = [];
  // What was handed to each of the other three, so what the pipeline asked for is observable.
  readonly crops: Array<{ input: string; crop: Crop }> = [];
  readonly contentBoxes: string[] = [];
  readonly rasters: Array<{ input: string; maxDim: number }> = [];
  failing = false;
  // What the detector and the fallback answer with, when a test cares.
  raster: GrayscaleRaster = { data: new Uint8Array(4), width: 2, height: 2 };
  box: Crop = {
    points: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  };

  async toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer> {
    const input = await describe(source);
    this.resizes.push({ maxDim: options.maxDim, quality: options.quality, input });
    if (this.failing) throw new Error('sharp: unsupported image format');
    return Buffer.from(`jpeg:${options.maxDim}:${input}`);
  }

  // The crop as a perspective transform (docs/05 §5.6). The result names what it was given and how
  // it was cut, so a test can see which page carried which quadrilateral into the canonical.
  async applyCrop(source: BinarySource, crop: Crop): Promise<Buffer> {
    const input = await describe(source);
    this.crops.push({ input, crop });
    if (this.failing) throw new Error('sharp: unsupported image format');
    return Buffer.from(`cropped(${crop.points[0][0]},${crop.points[0][1]}):${input}`);
  }

  async contentBox(source: BinarySource): Promise<Crop> {
    this.contentBoxes.push(await describe(source));
    if (this.failing) throw new Error('sharp: unsupported image format');
    return this.box;
  }

  async grayscaleRaster(source: BinarySource, maxDim: number): Promise<GrayscaleRaster> {
    this.rasters.push({ input: await describe(source), maxDim });
    if (this.failing) throw new Error('sharp: unsupported image format');
    return this.raster;
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

// The documentTypes the classifier is offered (docs/03 §3.3.12).
export class InMemoryCategoryRepository extends DocumentTypeRepository {
  readonly documentTypes: DocumentType[] = [];

  add(slug: string, description: string | null = null): DocumentType {
    const documentType: DocumentType = {
      id: `documentType-${this.documentTypes.length + 1}`,
      slug,
      name: slug,
      description,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    this.documentTypes.push(documentType);
    return documentType;
  }

  listActive(): Promise<DocumentType[]> {
    return Promise.resolve(
      this.documentTypes.filter((documentType) => documentType.deletedAt === null),
    );
  }

  listActiveWithCounts(): Promise<DocumentTypeWithCount[]> {
    return unused('listActiveWithCounts');
  }
  findById(id: string): Promise<DocumentType | null> {
    return Promise.resolve(
      this.documentTypes.find((documentType) => documentType.id === id) ?? null,
    );
  }
  findActiveBySlug(slug: string): Promise<DocumentType | null> {
    return Promise.resolve(
      this.documentTypes.find((documentType) => documentType.slug === slug) ?? null,
    );
  }
  create(): Promise<DocumentType> {
    return unused('create');
  }
  update(): Promise<DocumentType> {
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

// How many units inside one job run at once (docs/05 §5.4). A plain QueueSettings over an in-memory
// store: the class is what the pipeline takes, and there is nothing worth faking in it.
export function queueSettingsFixture(unitConcurrency = 4): QueueSettings {
  return new QueueSettings(new InMemorySettingsRepository(), {
    concurrency: {
      'library-scan': 1,
      'file-ingest': 1,
      'document-process': 1,
      maintenance: 1,
    },
    unitConcurrency,
  });
}

// Runs the body without a real transaction; the handle is never inspected by the fakes.
export class ImmediateUnitOfWork extends UnitOfWork {
  run<T>(fn: (tx: TransactionHandle) => Promise<T>): Promise<T> {
    return fn({});
  }
}

// The log, in memory: tests assert on what was recorded, in order (docs/03 §3.3.18).
export class FakeDocumentEventRepository extends DocumentEventRepository {
  readonly events: NewDocumentEvent[] = [];

  record(event: NewDocumentEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  listForDocument(
    documentId: string,
    query: { limit: number },
  ): Promise<{ items: DocumentEventView[]; nextCursor: string | null }> {
    return unused(`listForDocument(${documentId}, ${query.limit})`);
  }
}

// The people catalogue in memory: a name is one row, and the analyst may add to it (docs/03 §3.3.19).
export class InMemoryPersonRepository extends PersonRepository {
  moveDocumentLinks(): Promise<void> {
    return unused('moveDocumentLinks');
  }

  readonly people = new Map<string, Person>();
  readonly links = new Map<string, string[]>();

  listActive(): Promise<PersonWithCount[]> {
    return Promise.resolve(
      [...this.people.values()].map((person) => ({
        ...person,
        documentCount: [...this.links.values()].filter((ids) => ids.includes(person.id)).length,
      })),
    );
  }

  findById(id: string): Promise<Person | null> {
    return Promise.resolve(this.people.get(id) ?? null);
  }

  findByIds(ids: string[]): Promise<Person[]> {
    return Promise.resolve(ids.map((id) => this.people.get(id)).filter((p) => p !== undefined));
  }

  findByName(name: string): Promise<Person | null> {
    const wanted = name.trim().toLowerCase();
    return Promise.resolve(
      [...this.people.values()].find((person) => person.name.toLowerCase() === wanted) ?? null,
    );
  }

  create(input: { name: string; note?: string | null }): Promise<Person> {
    const person: Person = {
      id: `person-${this.people.size + 1}`,
      name: input.name,
      note: input.note ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    this.people.set(person.id, person);
    return Promise.resolve(person);
  }

  update(id: string, input: { name?: string; note?: string | null }): Promise<Person> {
    const person = this.people.get(id);
    if (person === undefined) throw new Error(`No person ${id}`);
    const updated = { ...person, ...(input.name === undefined ? {} : { name: input.name }) };
    this.people.set(id, updated);
    return Promise.resolve(updated);
  }

  softDelete(id: string, deletedAt: Date): Promise<void> {
    const person = this.people.get(id);
    if (person !== undefined) this.people.set(id, { ...person, deletedAt });
    return Promise.resolve();
  }

  listForDocument(documentId: string): Promise<Person[]> {
    const ids = this.links.get(documentId) ?? [];
    return Promise.resolve(ids.map((id) => this.people.get(id)).filter((p) => p !== undefined));
  }

  setForDocument(documentId: string, personIds: string[]): Promise<void> {
    this.links.set(documentId, personIds);
    return Promise.resolve();
  }
}

// The kinds catalogue in memory: what sort of thing a subject is, as a row (docs/03 §3.3.20a).
export class InMemorySubjectKindRepository extends SubjectKindRepository {
  readonly kinds = new Map<string, SubjectKind>();

  listActive(): Promise<SubjectKindWithCounts[]> {
    return Promise.resolve(
      [...this.kinds.values()].map((kind) => ({ ...kind, subjectCount: 0, documentCount: 0 })),
    );
  }

  findById(id: string): Promise<SubjectKind | null> {
    return Promise.resolve(this.kinds.get(id) ?? null);
  }

  findByName(name: string): Promise<SubjectKind | null> {
    const wanted = name.trim().toLowerCase();
    return Promise.resolve(
      [...this.kinds.values()].find((kind) => kind.name.toLowerCase() === wanted) ?? null,
    );
  }

  create(input: { name: string; note?: string | null }): Promise<SubjectKind> {
    const kind: SubjectKind = {
      id: `kind-${this.kinds.size + 1}`,
      name: input.name.trim().toLowerCase(),
      note: input.note ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    this.kinds.set(kind.id, kind);
    return Promise.resolve(kind);
  }

  update(id: string, input: { name?: string; note?: string | null }): Promise<SubjectKind> {
    const kind = this.kinds.get(id);
    if (kind === undefined) throw new Error(`No subject kind ${id}`);
    const updated = { ...kind, ...input };
    this.kinds.set(id, updated);
    return Promise.resolve(updated);
  }

  softDelete(id: string, deletedAt: Date): Promise<void> {
    const kind = this.kinds.get(id);
    if (kind !== undefined) this.kinds.set(id, { ...kind, deletedAt });
    return Promise.resolve();
  }

  countLivingSubjects(): Promise<number> {
    return unused('countLivingSubjects');
  }
}

// The subjects catalogue in memory (docs/03 §3.3.20).
export class InMemorySubjectRepository extends SubjectRepository {
  moveDocumentLinks(): Promise<void> {
    return unused('moveDocumentLinks');
  }

  readonly subjects = new Map<string, Subject>();
  readonly links = new Map<string, string[]>();

  // A subject shows its kind by name and stores it by id, so the double needs the catalogue the
  // handler is writing to (docs/03 §3.3.20a).
  constructor(private readonly kinds = new InMemorySubjectKindRepository()) {
    super();
  }

  listActive(): Promise<SubjectWithCount[]> {
    return Promise.resolve(
      [...this.subjects.values()].map((subject) => ({
        ...subject,
        documentCount: [...this.links.values()].filter((ids) => ids.includes(subject.id)).length,
      })),
    );
  }

  findById(id: string): Promise<Subject | null> {
    return Promise.resolve(this.subjects.get(id) ?? null);
  }

  findByKindAndName(kindId: string, name: string): Promise<Subject | null> {
    const wantedName = name.trim().toLowerCase();
    return Promise.resolve(
      [...this.subjects.values()].find(
        (subject) => subject.kindId === kindId && subject.name.toLowerCase() === wantedName,
      ) ?? null,
    );
  }

  create(input: { kindId: string; name: string; note?: string | null }): Promise<Subject> {
    const subject: Subject = {
      id: `subject-${this.subjects.size + 1}`,
      kindId: input.kindId,
      kind: this.kinds.kinds.get(input.kindId)?.name ?? input.kindId,
      name: input.name.trim(),
      note: input.note ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    this.subjects.set(subject.id, subject);
    return Promise.resolve(subject);
  }

  update(id: string, input: { kindId?: string; name?: string }): Promise<Subject> {
    const subject = this.subjects.get(id);
    if (subject === undefined) throw new Error(`No subject ${id}`);
    const updated = { ...subject, ...input };
    this.subjects.set(id, updated);
    return Promise.resolve(updated);
  }

  softDelete(id: string, deletedAt: Date): Promise<void> {
    const subject = this.subjects.get(id);
    if (subject !== undefined) this.subjects.set(id, { ...subject, deletedAt });
    return Promise.resolve();
  }

  listForDocument(documentId: string): Promise<Subject[]> {
    const ids = this.links.get(documentId) ?? [];
    return Promise.resolve(ids.map((id) => this.subjects.get(id)).filter((s) => s !== undefined));
  }

  setForDocument(documentId: string, subjectIds: string[]): Promise<void> {
    this.links.set(documentId, subjectIds);
    return Promise.resolve();
  }
}

export class FakeAnalyst extends DocumentAnalyst {
  configured = true;
  readonly endpoint = 'http://classifier.test';
  answer: DocumentAnalysis = {
    title: null,
    description: null,
    typeSlug: null,
    languages: [],
    country: null,
    city: null,
    people: [],
    date: null,
    subjects: [],
  };
  failing = false;
  readonly calls: Array<{ excerpt: string; documentTypes: readonly DocumentTypeOption[] }> = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  // The slug alone is what most tests care about; the place is opt-in via `answer`.
  set slug(value: string | null) {
    this.answer = { ...this.answer, typeSlug: value };
  }

  analyze(
    excerpt: string,
    documentTypes: readonly DocumentTypeOption[],
  ): Promise<DocumentAnalysis> {
    this.calls.push({ excerpt, documentTypes });
    if (this.failing) return Promise.reject(new Error('Analyst request failed with 503'));
    return Promise.resolve(this.answer);
  }
}

export class FakeEmbeddingProvider extends EmbeddingProvider {
  readonly endpoint = 'http://embeddings.test';
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

// The correlation id of one step, kept in a field rather than in AsyncLocalStorage: a test wants to
// know what the step was run under, and the production implementation is tested on its own.
export class FakeCallContext extends CallContext {
  private id: string | null = null;
  readonly ids: string[] = [];

  async run<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    this.ids.push(requestId);
    this.id = requestId;
    try {
      return await work();
    } finally {
      this.id = null;
    }
  }

  get current(): string | null {
    return this.id;
  }
}

// Instance settings in memory (docs/03 §3.3.21): a map, which is all the table is.
export class InMemorySettingsRepository extends SettingsRepository {
  readonly values = new Map<string, SettingValue>();

  read(key: string): Promise<SettingValue> {
    return Promise.resolve(this.values.get(key) ?? null);
  }

  write(key: string, value: SettingValue): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}
