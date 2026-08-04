import { Readable } from 'node:stream';
import {
  DocumentParser,
  type ParseOptions,
} from '../../src/server/application/ports/document-parser';
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
  type SearchMatch,
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
import {
  DocumentAnalyst,
  type DocumentTypeOption,
  type DocumentAnalysis,
} from '../../src/server/application/ports/document-analyst';
import { EmbeddingProvider } from '../../src/server/application/ports/embedding-provider';
import { CallContext } from '../../src/server/application/ports/call-context';
import type { Person } from '../../src/server/domain/entities/person';
import type { Subject } from '../../src/server/domain/entities/subject';
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

// Payloads carry ids as uuids, so fixtures do too.
export const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
export const LIBRARY_ID = '22222222-2222-4222-8222-222222222222';

export function documentFixture(overrides: Partial<Document> = {}): Document {
  return {
    id: DOCUMENT_ID,
    contentHash: 'a'.repeat(64),
    source: 'LIBRARY',
    titleSource: 'NONE',
    mimeType: 'application/pdf',
    ext: 'pdf',
    sizeBytes: 1024n,
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
  private created = 0;

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
    };
    this.documents.set(id, updated);
    return Promise.resolve(updated);
  }

  filterExistingIds(ids: string[]): Promise<string[]> {
    return Promise.resolve(ids.filter((id) => this.documents.has(id)));
  }

  findActiveByContentHash(contentHash: string): Promise<Document | null> {
    return Promise.resolve(
      [...this.documents.values()].find(
        (document) => document.contentHash === contentHash && document.deletedAt === null,
      ) ?? null,
    );
  }

  // The dedup primitive, in memory: known content yields the document that already holds it, new
  // content creates one (ADR-009).
  findOrCreateByContentHash(input: CreateDocumentInput): Promise<DocumentUpsert> {
    const existing = [...this.documents.values()].find(
      (document) => document.contentHash === input.contentHash && document.deletedAt === null,
    );
    if (existing !== undefined) return Promise.resolve({ document: existing, created: false });

    this.created += 1;
    const document = this.add(
      documentFixture({
        ...input,
        id: `created-${this.created}`,
        pageCount: null,
        markdown: null,
        steps: pendingSteps(),
      }),
    );
    return Promise.resolve({ document, created: true });
  }

  listYears(): Promise<Array<{ year: number; count: number }>> {
    return unused('listYears');
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
  readonly endpoint = 'http://stirling.test';
  readonly calls: PdfToolboxCall[] = [];
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

  async pdfToMarkdown(source: BinarySource): Promise<string> {
    const content = await describe(source);
    this.markdownReads.push(content);
    this.check('pdfToMarkdown');
    if (this.markdownFailing) throw new Error('Stirling pdfToMarkdown failed with 500');
    return this.markdownByContent.get(content) ?? this.defaultMarkdown;
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
// Not configured by default: the suites that predate Docling describe the fallback path, and the
// ones that care set `configured` and read `calls`.
export class FakeDocumentParser extends DocumentParser {
  readonly endpoint = 'http://docling.test';
  configured = false;
  markdown = '';
  readonly calls: Array<{ ocrLanguages: readonly string[] }> = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  toMarkdown(_source: BinarySource, options: ParseOptions): Promise<string> {
    this.calls.push({ ocrLanguages: options.ocrLanguages });
    return Promise.resolve(this.markdown);
  }
}

export class FakeImageTool extends ImageTool {
  readonly resizes: ResizeCall[] = [];
  // What was handed to trim(), so a scan set's crop mode is observable.
  readonly trims: string[] = [];
  failing = false;

  async toJpegPreview(source: BinarySource, options: JpegPreviewOptions): Promise<Buffer> {
    const input = await describe(source);
    this.resizes.push({ maxDim: options.maxDim, quality: options.quality, input });
    if (this.failing) throw new Error('sharp: unsupported image format');
    return Buffer.from(`jpeg:${options.maxDim}:${input}`);
  }

  async trim(source: BinarySource, threshold: number): Promise<Buffer> {
    const input = await describe(source);
    this.trims.push(input);
    if (this.failing) throw new Error('sharp: unsupported image format');
    return Buffer.from(`trimmed(${threshold}):${input}`);
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

// The subjects catalogue in memory (docs/03 §3.3.20).
export class InMemorySubjectRepository extends SubjectRepository {
  readonly subjects = new Map<string, Subject>();
  readonly links = new Map<string, string[]>();

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

  findByKindAndName(kind: string, name: string): Promise<Subject | null> {
    const wantedKind = kind.trim().toLowerCase();
    const wantedName = name.trim().toLowerCase();
    return Promise.resolve(
      [...this.subjects.values()].find(
        (subject) =>
          subject.kind.toLowerCase() === wantedKind && subject.name.toLowerCase() === wantedName,
      ) ?? null,
    );
  }

  create(input: { kind: string; name: string; note?: string | null }): Promise<Subject> {
    const subject: Subject = {
      id: `subject-${this.subjects.size + 1}`,
      kind: input.kind.trim().toLowerCase(),
      name: input.name.trim(),
      note: input.note ?? null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    this.subjects.set(subject.id, subject);
    return Promise.resolve(subject);
  }

  update(id: string, input: { kind?: string; name?: string }): Promise<Subject> {
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
