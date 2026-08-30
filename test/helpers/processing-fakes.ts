import { Readable } from 'node:stream';
import {
  DocumentParser,
  type ParseOptions,
} from '../../src/server/application/ports/document-parser';
import { ServiceUnavailableError } from '../../src/server/application/ports/service-unavailable';
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
  type DocumentFilterInput,
  type DocumentGroupCount,
  type DocumentListItem,
  type DocumentListPage,
  type SearchMatch,
  type StaleDocument,
  type StepStatusCounters,
  type Viewer,
} from '../../src/server/domain/repositories/document.repository';
import {
  FileRepository,
  type CreateFileInput,
  type DocumentFile,
  type DocumentPageWithFile,
  type FileRefView,
  type TrashedFile,
} from '../../src/server/domain/repositories/file.repository';
import {
  entryOf,
  samePages,
  sameListing,
  withExpandedPages,
  type DocumentPage,
  type PageEntry,
} from '../../src/server/domain/entities/document-page';
import { ConflictError } from '../../src/server/domain/errors/domain-error';
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
import {
  DOCUMENT_STEPS,
  type Crop,
  type DocumentGroupBy,
  type DocumentStep,
  type Rotation,
} from '../../src/shared/contracts/documents';
import type { StepStatus, TrashReason } from '../../src/shared/contracts/enums';
import { toBuffer, type BinarySource } from '../../src/server/application/ports/binary-source';
import { ImageTool, type JpegPreviewOptions } from '../../src/server/application/ports/image-tool';
import type { GrayscaleRaster } from '../../src/server/domain/entities/page-detection';
import { QueueSettings, ungatedServices } from '../../src/server/application/queue/queue-settings';
import {
  LibraryReader,
  type FsDirectoryEntry,
  type FsEntry,
  type LibraryLocation,
  type WalkResult,
} from '../../src/server/application/ports/library-reader';
import {
  PdfToolbox,
  type PageRenderOptions,
  type NamedBinary,
  type PageScale,
  type PdfMetadata,
} from '../../src/server/application/ports/pdf-toolbox';
import {
  DocumentAnalyst,
  type ConfirmedValues,
  type DocumentTypeOption,
  type FieldExtraction,
  type KnownPerson,
  type KnownSubject,
  type PageImage,
  type DocumentAnalysis,
} from '../../src/server/application/ports/document-analyst';
import type { DocumentFieldSchema } from '../../src/shared/contracts/document-fields';
import { EmbeddingProvider } from '../../src/server/application/ports/embedding-provider';
import {
  PageTranscriber,
  type TranscriptionUsage,
} from '../../src/server/application/ports/page-transcriber';
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
  type SubjectKindListRow,
  type SubjectKindWithCounts,
} from '../../src/server/domain/repositories/subject-kind.repository';
import {
  SubjectRepository,
  type SubjectListRow,
  type SubjectWithCount,
} from '../../src/server/domain/repositories/subject.repository';
import {
  PersonRepository,
  type PersonListRow,
  type PersonWithCount,
} from '../../src/server/domain/repositories/person.repository';
import {
  DocumentEventRepository,
  type DocumentEventView,
  type NewDocumentEvent,
} from '../../src/server/domain/repositories/document-event.repository';
import {
  UnitOfWork,
  type TransactionBounds,
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
    'fields',
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
    pageFormat: 'AUTO',
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
    extracted: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastEventAt: new Date('2026-01-01T00:00:00.000Z'),
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
      ...(update.extracted === undefined ? {} : { extracted: update.extracted }),
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

  // Whatever a test puts here is what the shelves are; what it was asked is kept, so a caller can
  // be held to passing the filters on and nothing else (docs/07 §7.3).
  groups: DocumentGroupCount[] | null = null;
  asked: { viewer: Viewer; by: DocumentGroupBy; filters: DocumentFilterInput } | null = null;

  countByGroup(
    viewer: Viewer,
    by: DocumentGroupBy,
    filters: DocumentFilterInput,
  ): Promise<DocumentGroupCount[]> {
    this.asked = { viewer, by, filters };
    return this.groups === null ? unused('countByGroup') : Promise.resolve(this.groups);
  }

  readonly updatedAt = new Map<string, Date>();

  setUpdatedAt(documentId: string, at: Date): void {
    this.updatedAt.set(documentId, at);
  }

  markUnstartedQueued(documentId: string, steps: readonly DocumentStep[]): Promise<void> {
    const document = this.documents.get(documentId);
    if (document !== undefined && document.deletedAt === null) {
      // Written out rather than mapped: an assertion back to DocumentSteps is forbidden here
      // (docs/14 §14.1), and the compiler should be the one checking every step is present.
      const queued = (step: DocumentStep): StepStatus => {
        const status = document.steps[step];
        return steps.includes(step) && status === 'PENDING' ? 'QUEUED' : status;
      };
      this.documents.set(documentId, {
        ...document,
        steps: {
          canonical: queued('canonical'),
          preview: queued('preview'),
          markdown: queued('markdown'),
          analysis: queued('analysis'),
          fields: queued('fields'),
          vectorization: queued('vectorization'),
        },
      });
    }
    return Promise.resolve();
  }

  listStaleUnstartedIds(
    olderThan: Date,
    limit: number,
    ignored: readonly DocumentStep[],
  ): Promise<StaleDocument[]> {
    const considered = DOCUMENT_STEPS.filter((step) => !ignored.includes(step));
    // `updatedAt` is a column, not part of the domain entity, so the fake keeps its own note of
    // when a row was last written and the test drives it through `setUpdatedAt`.
    const stale = [...this.documents.values()]
      .filter(
        (document: Document) =>
          document.deletedAt === null &&
          (this.updatedAt.get(document.id) ?? document.createdAt).getTime() < olderThan.getTime(),
      )
      .map((document: Document) => ({
        id: document.id,
        steps: considered.filter(
          (step) => document.steps[step] === 'PENDING' || document.steps[step] === 'QUEUED',
        ),
      }))
      // A document held only on a paused step is not waiting for anything this sweep can give it
      // (docs/05 §5.4d).
      .filter((stalled) => stalled.steps.length > 0);
    return Promise.resolve(stale.slice(0, limit));
  }

  // Newest first, like the query it stands in for (docs/07 §7.3).
  listIdsByStepStatus(step: DocumentStep, status: StepStatus, limit: number): Promise<string[]> {
    const matching = [...this.documents.values()]
      .filter(
        (document: Document) => document.deletedAt === null && document.steps[step] === status,
      )
      .sort((a: Document, b: Document) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(matching.slice(0, limit).map((document: Document) => document.id));
  }

  countByStepStatus(): Promise<StepStatusCounters> {
    return unused('countByStepStatus');
  }
  listReadableItems(): Promise<DocumentListItem[]> {
    return unused('listReadableItems');
  }

  listReadable(): Promise<DocumentListPage> {
    return unused('listReadable');
  }
  // Whatever a test puts here decides what the viewer may read; absent means "not readable".
  readable = new Map<string, DocumentDetail>();

  findReadableById(id: string): Promise<DocumentDetail | null> {
    return Promise.resolve(this.readable.get(id) ?? null);
  }
  listInFolder(): Promise<DocumentListPage> {
    return unused('listInFolder');
  }
  listInCollection(): Promise<DocumentListPage> {
    return unused('listInCollection');
  }
  countReadableInCollections(): Promise<ReadonlyMap<string, number>> {
    return unused('countReadableInCollections');
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

  // The row goes, and so does everything the schema cascades from it (docs/03 §3.3.10) — here that
  // is the composition, which the file fake keeps.
  hardDelete(id: string): Promise<void> {
    this.documents.delete(id);
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
    // Nobody has counted the pages inside it: what every file reads as until a canonical build opens
    // it, and while it does a document holds it as one entry standing for it whole (docs/03 §3.3.16).
    pageCount: null,
    // Read by a document, which is where a file is unless somebody put it in the trash
    // (docs/05 §5.7a).
    trashedAt: null,
    trashedReason: null,
    trashedFrom: null,
    replacedById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

// The bytes, once, and which pages of which documents read them (docs/03 §3.3.16–3.3.17, ADR-025).
// The map of lists is `document_pages`: an ordered list of entries per document, exactly as the
// schema holds it.
export class InMemoryFileRepository extends FileRepository {
  readonly files = new Map<string, File>();
  // documentId → the entries of that document, in position order.
  readonly composition = new Map<string, DocumentPage[]>();
  private created = 0;
  private entries = 0;

  // Adds a file and, unless told otherwise, has a document read it — which is where a file is.
  add(file: Partial<File> = {}, documentId: string | null = DOCUMENT_ID): File {
    const full = fileFixture({ id: file.id ?? `file-${this.files.size + 1}`, ...file });
    this.files.set(full.id, full);
    if (documentId !== null) this.seedPages(documentId, full);
    return full;
  }

  // The fixture's own shortcut for "a document already reads this file": its own pages where a build
  // has counted them, and one entry standing for the file whole where none has (docs/03 §3.3.17).
  // Not what any production path does any more — those hand `appendPages` the entries they mean.
  private seedPages(documentId: string, file: File): void {
    const held = this.composition.get(documentId) ?? [];
    const count = file.pageCount === null || file.pageCount < 1 ? null : file.pageCount;
    const indices: (number | null)[] =
      count === null ? [null] : Array.from({ length: count }, (unused, index) => index);
    this.composition.set(documentId, [
      ...held,
      ...indices.map((pageIndex, offset) => {
        this.entries += 1;
        return {
          id: `page-${this.entries}`,
          documentId,
          position: held.length + offset,
          fileId: file.id,
          pageIndex,
          turn: null,
          crop: null,
          cropSource: 'NONE' as const,
        };
      }),
    ]);
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
    // The caller's id where it gave one, the way the database honours an explicit primary key: an
    // upload writes its object under `files/{id}/…` before the row exists, and the row has to come
    // back carrying that same id or the orphan sweep would delete a live original (docs/09 §9.2).
    const file = fileFixture({ ...input, id: input.id ?? `file-created-${this.created}` });
    this.files.set(file.id, file);
    return Promise.resolve({ file, created: true });
  }

  // What the last canonical build counted in this file (docs/05 §5.5 step 1). Recorded rather
  // than asserted on directly, so a test can watch the count arrive on a file that had none.
  recordPageCount(id: string, pageCount: number): Promise<void> {
    const file = this.files.get(id);
    if (file !== undefined) this.files.set(id, { ...file, pageCount });
    return Promise.resolve();
  }

  softDelete(id: string, deletedAt: Date): Promise<void> {
    const file = this.files.get(id);
    if (file !== undefined) this.files.set(id, { ...file, deletedAt });
    return Promise.resolve();
  }

  hardDelete(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      this.files.delete(id);
      // The entries go with the document in the schema; here it is one map, so the pages reading a
      // deleted file go with it rather than being left pointing at nothing.
      for (const [documentId, held] of this.composition) {
        this.renumber(
          documentId,
          held.filter((page) => page.fileId !== id),
        );
      }
    }
    return Promise.resolve();
  }

  filterExistingIds(ids: string[]): Promise<string[]> {
    return Promise.resolve(ids.filter((id) => this.files.has(id)));
  }

  // --- the trash (docs/05 §5.7a) --------------------------------------------------------------

  trash(input: {
    fileIds: readonly string[];
    reason: TrashReason;
    trashedFrom: string | null;
    replacedById?: string | undefined;
    at: Date;
  }): Promise<void> {
    // The versions this page already had follow it, so every copy points at the file in the
    // document now — the same re-pointing the schema does.
    if (input.replacedById !== undefined) {
      for (const [id, file] of this.files) {
        if (file.replacedById !== null && input.fileIds.includes(file.replacedById)) {
          this.files.set(id, { ...file, replacedById: input.replacedById });
        }
      }
    }

    for (const fileId of input.fileIds) {
      const file = this.files.get(fileId);
      if (file === undefined) continue;
      this.files.set(fileId, {
        ...file,
        trashedAt: input.at,
        trashedReason: input.reason,
        trashedFrom: input.trashedFrom,
        replacedById: input.replacedById ?? null,
      });
      for (const [documentId, held] of this.composition) {
        this.renumber(
          documentId,
          held.filter((page) => page.fileId !== fileId),
        );
      }
    }
    return Promise.resolve();
  }

  untrash(id: string): Promise<File> {
    const file = this.files.get(id);
    if (file === undefined) throw new Error(`No file ${id}`);
    const restored: File = {
      ...file,
      trashedAt: null,
      trashedReason: null,
      trashedFrom: null,
      replacedById: null,
    };
    this.files.set(id, restored);
    return Promise.resolve(restored);
  }

  listVersionsFor(fileIds: readonly string[]): Promise<Map<string, File[]>> {
    const byFile = new Map<string, File[]>(fileIds.map((id) => [id, []]));
    for (const file of this.files.values()) {
      if (file.replacedById === null) continue;
      byFile.get(file.replacedById)?.push(file);
    }
    for (const versions of byFile.values()) {
      versions.sort((a, b) => (b.trashedAt?.getTime() ?? 0) - (a.trashedAt?.getTime() ?? 0));
    }
    return Promise.resolve(byFile);
  }

  listTrashed(query: {
    limit: number;
    cursor?: Date | undefined;
  }): Promise<{ items: TrashedFile[]; totalItems: number; totalBytes: bigint }> {
    const inTheTrash = [...this.files.values()]
      .filter((file) => file.trashedAt !== null)
      .sort((a, b) => (b.trashedAt?.getTime() ?? 0) - (a.trashedAt?.getTime() ?? 0));
    const page = inTheTrash
      .filter(
        (file) =>
          query.cursor === undefined || (file.trashedAt?.getTime() ?? 0) < query.cursor.getTime(),
      )
      .slice(0, query.limit);
    return Promise.resolve({
      items: page.map((file) => ({ ...file, available: file.origin === 'MANAGED', refs: [] })),
      totalItems: inTheTrash.length,
      totalBytes: inTheTrash.reduce((total, file) => total + file.sizeBytes, 0n),
    });
  }

  listAllTrashed(): Promise<File[]> {
    return Promise.resolve([...this.files.values()].filter((file) => file.trashedAt !== null));
  }

  listPurgeable(before: Date, limit: number): Promise<File[]> {
    return Promise.resolve(
      [...this.files.values()]
        // 🔒 MANAGED only: a library original is on a read-only volume, so no window closes on it.
        .filter(
          (file) =>
            file.origin === 'MANAGED' &&
            file.trashedAt !== null &&
            file.trashedAt.getTime() <= before.getTime(),
        )
        .slice(0, limit),
    );
  }

  listPagesForDocument(documentId: string): Promise<DocumentPageWithFile[]> {
    const held = this.composition.get(documentId) ?? [];
    return Promise.resolve(
      held.flatMap((page) => {
        const file = this.files.get(page.fileId);
        return file === undefined ? [] : [{ ...page, file }];
      }),
    );
  }

  // 🔒 The precondition is honoured here exactly as the database honours it, because a fake that
  // waved it through would let every test pass over the one bug this guard exists for: an edit
  // computed from a reading of the list that is no longer the list (docs/03 §3.3.17).
  replacePages(
    documentId: string,
    input: { pages: readonly PageEntry[]; expecting: readonly PageEntry[] | null },
  ): Promise<void> {
    if (input.expecting !== null) {
      const held = (this.composition.get(documentId) ?? []).map(entryOf);
      if (!sameListing(input.expecting, held)) {
        return Promise.reject(
          new ConflictError(
            'DOCUMENT_CHANGED',
            'This document has been edited since the list this change was computed from; read it again',
          ),
        );
      }
    }
    this.entries += input.pages.length;
    this.composition.set(
      documentId,
      input.pages.map((page, position) => ({
        id: page.id ?? `page-${this.entries}-${position}`,
        documentId,
        position,
        fileId: page.fileId,
        pageIndex: page.pageIndex,
        turn: page.turn,
        crop: page.crop,
        cropSource: page.cropSource,
      })),
    );
    return Promise.resolve();
  }

  // The files those pages are read from, in the order the pages first name them (docs/03 §3.3.17).
  async listForDocument(documentId: string): Promise<DocumentFile[]> {
    const pages = await this.listPagesForDocument(documentId);
    const files: DocumentFile[] = [];
    const byFile = new Map<string, DocumentFile>();
    for (const page of pages) {
      const { file, ...entry } = page;
      const held = byFile.get(page.fileId);
      if (held === undefined) {
        const one: DocumentFile = { ...file, position: files.length, pages: [entry] };
        byFile.set(page.fileId, one);
        files.push(one);
        continue;
      }
      held.pages.push(entry);
    }
    return files;
  }

  async listForDocuments(documentIds: readonly string[]): Promise<Map<string, DocumentFile[]>> {
    const out = new Map<string, DocumentFile[]>();
    for (const documentId of documentIds) {
      out.set(documentId, await this.listForDocument(documentId));
    }
    return out;
  }

  findDocumentIdForFile(fileId: string): Promise<string | null> {
    for (const [documentId, pages] of this.composition) {
      if (pages.some((page) => page.fileId === fileId)) return Promise.resolve(documentId);
    }
    return Promise.resolve(null);
  }

  filterFilesWithoutLivePages(fileIds: readonly string[]): Promise<string[]> {
    const read = new Set<string>();
    for (const pages of this.composition.values()) {
      for (const page of pages) read.add(page.fileId);
    }
    return Promise.resolve(fileIds.filter((fileId) => !read.has(fileId)));
  }

  listDocumentIdsForFile(fileId: string): Promise<string[]> {
    const found = [...this.composition]
      .filter(([, pages]) => pages.some((page) => page.fileId === fileId))
      .map(([documentId]) => documentId);
    return Promise.resolve(found.sort());
  }

  // After whatever the document holds now — the one composition write with no precondition, because
  // appending cannot lose anything (docs/03 §3.3.17). The entries are the caller's: nothing here
  // re-derives a page list from a file's page count, which is what the method this replaced did.
  appendPages(documentId: string, pages: readonly PageEntry[]): Promise<void> {
    const held = this.composition.get(documentId) ?? [];
    this.composition.set(documentId, [
      ...held,
      ...pages.map((page, offset) => {
        this.entries += 1;
        return {
          id: page.id ?? `page-${this.entries}`,
          documentId,
          position: held.length + offset,
          fileId: page.fileId,
          pageIndex: page.pageIndex,
          turn: page.turn,
          crop: page.crop,
          cropSource: page.cropSource,
        };
      }),
    ]);
    return Promise.resolve();
  }

  // There is one thread here, so "held for the rest of the transaction" is nothing to model — but
  // the read is the same read, and a caller using this instead of a snapshot is doing the right
  // thing for the right reason.
  lockPagesForDocument(documentId: string): Promise<DocumentPageWithFile[]> {
    return this.listPagesForDocument(documentId);
  }

  // 🔒 Expanded from the list **as it stands**, not from a snapshot the caller brought: this is the
  // whole point of the method, and a fake that took the caller's list would prove the opposite of
  // what the tests are for (docs/05 §5.5 step 1).
  async expandWholeFileEntries(
    documentId: string,
    pageCounts: ReadonlyMap<string, number>,
  ): Promise<DocumentPageWithFile[]> {
    const held = await this.listPagesForDocument(documentId);
    const expanded = withExpandedPages(held.map(entryOf), pageCounts);
    if (samePages(held, expanded)) return held;
    await this.replacePages(documentId, { pages: expanded, expecting: null });
    return this.listPagesForDocument(documentId);
  }

  // Positions are contiguous (docs/03 §3.3.17), so whatever is left closes up behind what went.
  private renumber(documentId: string, pages: readonly DocumentPage[]): void {
    this.composition.set(
      documentId,
      pages.map((page, position) => ({ ...page, position })),
    );
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

  // The tombstone a deletion leaves on the volume (docs/03 §3.3.9): the ref survives the file.
  markExcluded(fileIds: readonly string[]): Promise<void> {
    for (const [index, ref] of this.refs.entries()) {
      if (ref.fileId !== null && fileIds.includes(ref.fileId)) {
        this.refs[index] = { ...ref, status: 'EXCLUDED', fileId: null };
      }
    }
    return Promise.resolve();
  }

  // Everywhere these bytes were seen — by hash as well as by id, since an excluded ref points at no
  // file (docs/03 §3.3.9).
  listForFile(fileId: string, contentHash: string): Promise<FileRefView[]> {
    return Promise.resolve(
      this.refs
        .filter((ref) => ref.fileId === fileId || ref.contentHash === contentHash)
        .map((ref) => ({
          libraryId: ref.libraryId,
          libraryName: 'Library',
          path: ref.path.value,
          status: ref.status,
        })),
    );
  }

  // And the way back, by hash: excluding the ref is what cleared its `fileId` (docs/05 §5.7a).
  markRestored(fileId: string, contentHash: string): Promise<void> {
    for (const [index, ref] of this.refs.entries()) {
      if (ref.status === 'EXCLUDED' && ref.contentHash === contentHash) {
        this.refs[index] = { ...ref, status: 'HASHED', fileId };
      }
    }
    return Promise.resolve();
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

  // The container being away rather than choking on a file (docs/05 §5.4e).
  unavailable = false;

  private check(method: string, fileName?: string): void {
    this.calls.push(fileName === undefined ? { method } : { method, fileName });
    if (this.unavailable) throw new ServiceUnavailableError('stirling', 'fetch failed');
    if (this.failures.has(method)) {
      const detail = this.failureDetail === '' ? '' : `: ${this.failureDetail}`;
      throw new Error(`Stirling ${method} failed with 500${detail}`);
    }
  }

  toPdf(source: NamedBinary): Promise<Buffer> {
    this.check('toPdf', source.fileName);
    return Promise.resolve(Buffer.from('converted-pdf'));
  }

  // Which page was asked for and at what resolution: a cropped page of a PDF is rendered before its
  // quadrilateral is applied (docs/05 §5.5 step 1), and which page that is matters.
  pdfPageJpg(_source: BinarySource, options?: PageRenderOptions): Promise<Buffer> {
    const page = options?.page ?? 1;
    this.check(
      'pdfPageJpg',
      options?.dpi === undefined ? `page:${page}` : `page:${page}@${options.dpi}`,
    );
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

  // Every page onto a named size, once the text layer is there to be carried along
  // (docs/05 §5.5 step 1). The result names the geometry, so a test can assert *what* was asked for
  // and — because the call is recorded in order — that it came after the OCR and not before it.
  async scalePages(source: BinarySource, geometry: PageScale): Promise<Buffer> {
    this.check('scalePages', `${geometry.pageSize}:${geometry.orientation}`);
    return Buffer.from(
      `scaled-${geometry.pageSize}-${geometry.orientation}(${await describe(source)})`,
    );
  }

  async imagesToPdf(images: readonly NamedBinary[]): Promise<Buffer> {
    // The names are the interesting part: page order is item order (docs/05 §5.5 step 1).
    this.check('imagesToPdf', images.map((image) => image.fileName).join(','));
    // Carries what it was given, so a test can follow one page's bytes into the canonical.
    const bodies = await Promise.all(images.map((image) => describe(image.body)));
    return Buffer.from(`image-pdf(${bodies.join(',')})`);
  }

  // The pages of one file put into the order the document holds them in (docs/05 §5.5 step 1). The call
  // names the order it was given and the result carries it, so a test can see both that the
  // rearrange happened and what it was asked for — and that it did not happen at all where the
  // pages already stand as they should.
  async rearrangePages(source: BinarySource, order: readonly number[]): Promise<Buffer> {
    this.check('rearrangePages', order.join(','));
    return Buffer.from(`rearranged(${order.join(',')})(${await describe(source)})`);
  }

  // The pages of one file stood the way up their entries say (docs/05 §5.5 step 1). Named and
  // carried like the rearrange above, so a test can see which turns were asked for and — the calls
  // being recorded in order — that they were asked for before the pages were put in order.
  async rotatePages(source: BinarySource, rotations: readonly number[]): Promise<Buffer> {
    this.check('rotatePages', rotations.join(','));
    return Buffer.from(`rotated(${rotations.join(',')})(${await describe(source)})`);
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
  readonly calls: Array<{ ocrLanguages: readonly string[]; pageCount: number }> = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  // The service being away rather than the document failing to parse (docs/05 §5.4e).
  unavailable = false;

  toMarkdown(_source: BinarySource, options: ParseOptions): Promise<string> {
    this.calls.push({ ocrLanguages: options.ocrLanguages, pageCount: options.pageCount });
    if (this.unavailable) {
      return Promise.reject(new ServiceUnavailableError('docling', 'fetch failed'));
    }
    if (this.failing) return Promise.reject(new Error('Docling toMarkdown failed with 500'));
    return Promise.resolve(this.markdown);
  }
}

export class FakeImageTool extends ImageTool {
  readonly resizes: ResizeCall[] = [];
  // What every image is reported to be, unless a test says otherwise: an A4 sheet standing up, which
  // is what most of an archive is.
  size: { width: number; height: number } = { width: 2480, height: 3508 };
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

  // Which way up the paper lay (docs/03 §3.3.16). Like the crop above, the result names what it was
  // given and how it was turned, so a test can follow one page through the crop *and* the turn and
  // see which came first.
  readonly rotations: Array<{ input: string; rotation: Rotation }> = [];

  async applyRotation(source: BinarySource, rotation: Rotation): Promise<Buffer> {
    const input = await describe(source);
    this.rotations.push({ input, rotation });
    if (this.failing) throw new Error('sharp: unsupported image format');
    const mirror = rotation.mirrored ? 'm' : '';
    return Buffer.from(`turned(${rotation.quarterTurns}${mirror}):${input}`);
  }

  // Levelling and deskewing (docs/05 §5.5 step 1). What each page was handed to it, and what it
  // answers with — its own switch rather than `failing`, because most of the suite is about other
  // things and a fake that rewrote every page would put its own name in every assertion. `none`,
  // the default, is what an already flat and straight scan gets: the page is left alone.
  readonly corrections: string[] = [];
  correction: 'none' | 'applied' | 'failing' = 'none';

  async correctPage(source: BinarySource): Promise<Buffer | null> {
    const input = await describe(source);
    this.corrections.push(input);
    if (this.correction === 'failing') throw new Error('sharp: unsupported image format');
    return this.correction === 'none' ? null : Buffer.from(`corrected(${input})`);
  }

  // What the shape of the page was read off. The size answered is the same every time — the point
  // of recording it is *which* picture was measured, because the format of the canonical is decided
  // from the page as it will be, after the crop and the turn (docs/05 §5.5 step 1).
  readonly measured: string[] = [];

  async dimensions(source: BinarySource): Promise<{ width: number; height: number }> {
    this.measured.push(await describe(source));
    return this.size;
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
  clearTypeFromDocuments(): Promise<number> {
    return unused('clearTypeFromDocuments');
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

  countByModel(): Promise<Array<{ model: string | null; chunks: number }>> {
    const counts = new Map<string, number>();
    for (const chunks of this.byDocument.values()) {
      for (const chunk of chunks) counts.set(chunk.model, (counts.get(chunk.model) ?? 0) + 1);
    }
    return Promise.resolve(
      [...counts].map(([model, chunks]) => ({ model, chunks })).sort((a, b) => b.chunks - a.chunks),
    );
  }
}

// How many units inside one job run at once (docs/05 §5.4), and which steps are held (§5.4d). A
// plain QueueSettings over an in-memory store: the class is what the pipeline takes, and there is
// nothing worth faking in it. A test that pauses a step passes its own store in and writes to it.
export function queueSettingsFixture(
  unitConcurrency = 4,
  settings: InMemorySettingsRepository = new InMemorySettingsRepository(),
): QueueSettings {
  return new QueueSettings(settings, {
    concurrency: {
      'library-scan': 1,
      'file-ingest': 1,
      'document-process': 1,
      maintenance: 1,
    },
    unitConcurrency,
    services: ungatedServices(),
  });
}

// Runs the body without a real transaction; the handle is never inspected by the fakes. The bound
// each run asked for is kept, in order, so a test can assert that a caller which needs one says so
// (docs/06 §6.3.4) — `undefined` is a run that took the adapter's default.
export class ImmediateUnitOfWork extends UnitOfWork {
  readonly bounds: Array<TransactionBounds | undefined> = [];

  run<T>(fn: (tx: TransactionHandle) => Promise<T>, bounds?: TransactionBounds): Promise<T> {
    this.bounds.push(bounds);
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

  async listPage(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: PersonListRow[]; nextCursor: string | null }> {
    // The fakes serve unit tests that never page or sort: one page holds everything, dateless.
    void query;
    const items = await this.listActive();
    return { items: items.map((row) => ({ ...row, lastDocumentAt: null })), nextCursor: null };
  }

  async findListRow(id: string): Promise<PersonListRow | null> {
    const page = await this.listPage({ limit: 1 });
    return page.items.find((row) => row.id === id) ?? null;
  }

  // Living rows only, because that is what the instance ceiling counts (docs/08 §8.4, SEC-56).
  countActive(): Promise<number> {
    return Promise.resolve(
      [...this.people.values()].filter((person) => person.deletedAt === null).length,
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

  async listPage(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: SubjectKindListRow[]; nextCursor: string | null }> {
    void query;
    const items = await this.listActive();
    return { items: items.map((row) => ({ ...row, lastDocumentAt: null })), nextCursor: null };
  }

  async findListRow(id: string): Promise<SubjectKindListRow | null> {
    const page = await this.listPage({ limit: 1 });
    return page.items.find((row) => row.id === id) ?? null;
  }

  // Living rows only, because that is what the instance ceiling counts (docs/08 §8.4, SEC-51).
  countActive(): Promise<number> {
    return Promise.resolve(
      [...this.kinds.values()].filter((kind) => kind.deletedAt === null).length,
    );
  }

  findById(id: string): Promise<SubjectKind | null> {
    return Promise.resolve(this.kinds.get(id) ?? null);
  }

  findByIds(ids: string[]): Promise<SubjectKind[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const kind = this.kinds.get(id);
        return kind === undefined || kind.deletedAt !== null ? [] : [kind];
      }),
    );
  }

  findByName(name: string): Promise<SubjectKind | null> {
    const wanted = name.trim().toLowerCase();
    return Promise.resolve(
      [...this.kinds.values()].find(
        (kind) => kind.deletedAt === null && kind.name.toLowerCase() === wanted,
      ) ?? null,
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
  moveDocumentLinks(fromIds: string[], toId: string): Promise<void> {
    for (const [documentId, ids] of this.links) {
      if (!ids.some((id) => fromIds.includes(id))) continue;
      // The collapse the real repository gets from `skipDuplicates` (docs/03 §3.3.20).
      this.links.set(documentId, [...new Set(ids.map((id) => (fromIds.includes(id) ? toId : id)))]);
    }
    return Promise.resolve();
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

  async listPage(query: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ items: SubjectListRow[]; nextCursor: string | null }> {
    void query;
    const items = await this.listActive();
    return { items: items.map((row) => ({ ...row, lastDocumentAt: null })), nextCursor: null };
  }

  async findListRow(id: string): Promise<SubjectListRow | null> {
    const page = await this.listPage({ limit: 1 });
    return page.items.find((row) => row.id === id) ?? null;
  }

  // Living rows only, because that is what the instance ceiling counts (docs/08 §8.4, SEC-56).
  countActive(): Promise<number> {
    return Promise.resolve(
      [...this.subjects.values()].filter((subject) => subject.deletedAt === null).length,
    );
  }

  findById(id: string): Promise<Subject | null> {
    return Promise.resolve(this.subjects.get(id) ?? null);
  }

  findByIds(ids: string[]): Promise<Subject[]> {
    return Promise.resolve(
      ids.flatMap((id) => {
        const subject = this.subjects.get(id);
        return subject === undefined ? [] : [subject];
      }),
    );
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

  listByKinds(kindIds: string[]): Promise<Subject[]> {
    return Promise.resolve(
      [...this.subjects.values()].filter(
        (subject) => subject.deletedAt === null && kindIds.includes(subject.kindId),
      ),
    );
  }

  moveToKind(ids: string[], kindId: string): Promise<void> {
    for (const id of ids) {
      const subject = this.subjects.get(id);
      if (subject === undefined) continue;
      this.subjects.set(id, {
        ...subject,
        kindId,
        kind: this.kinds.kinds.get(kindId)?.name ?? kindId,
      });
    }
    return Promise.resolve();
  }
}

export class FakeAnalyst extends DocumentAnalyst {
  // The provider being away rather than answering badly (docs/05 §5.4e).
  unavailable = false;
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
    textQuality: null,
    // What the run thought of its own work (docs/05 §5.5 step 4). Silent unless a test says
    // otherwise — most of them are about something else, and a missing mark is not a zero.
    legibility: null,
    extraction: null,
  };
  failing = false;
  readonly calls: Array<{
    excerpt: string;
    documentTypes: readonly DocumentTypeOption[];
    // The catalogues as they travelled (docs/03 §3.3.19–20): what the model was told the archive
    // already holds, in the order it was told it — the order matters, because the adapter caps the
    // list and the cap must fall on the tail (docs/05 §5.5 step 4).
    knownSubjects: readonly KnownSubject[];
    knownPeople: readonly KnownPerson[];
    // How many pages travelled with the text: a document is a picture before it is a string, and
    // a test that cares about step 4's input cares about this (docs/05 §5.5 step 4).
    pages: number;
    // What a person had already settled when this call was made (docs/05 §5.5 step 4).
    confirmed: ConfirmedValues;
  }> = [];

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
    _subjectKinds: readonly string[] = [],
    knownSubjects: readonly KnownSubject[] = [],
    knownPeople: readonly KnownPerson[] = [],
    _language?: string,
    pages: readonly PageImage[] = [],
    confirmed: ConfirmedValues = {},
  ): Promise<DocumentAnalysis> {
    this.calls.push({
      excerpt,
      documentTypes,
      knownSubjects,
      knownPeople,
      pages: pages.length,
      confirmed,
    });
    if (this.unavailable) {
      return Promise.reject(new ServiceUnavailableError('classifier', 'fetch failed'));
    }
    if (this.failing) return Promise.reject(new Error('Analyst request failed with 500'));
    return Promise.resolve(this.answer);
  }

  // The fields step's question (docs/05 §5.5 step 5); tests set `fieldValues` per case.
  fieldValues: Record<string, unknown> = {};
  // And how sure it says it is of the whole reading; null is a step that did not answer.
  fieldConfidence: number | null = null;
  readonly fieldCalls: Array<{
    schemaSlug: string;
    excerpt: string;
    pages: number;
    confirmed: ConfirmedValues;
  }> = [];

  extractFields(
    schema: DocumentFieldSchema,
    excerpt: string,
    pages: readonly PageImage[] = [],
    confirmed: ConfirmedValues = {},
  ): Promise<FieldExtraction> {
    this.fieldCalls.push({
      schemaSlug: schema.typeSlug,
      excerpt,
      pages: pages.length,
      confirmed,
    });
    if (this.unavailable) {
      return Promise.reject(new ServiceUnavailableError('classifier', 'fetch failed'));
    }
    if (this.failing) return Promise.reject(new Error('Analyst request failed with 500'));
    return Promise.resolve({ values: this.fieldValues, confidence: this.fieldConfidence });
  }
}

// The recogniser of last resort (docs/05 §5.5 step 3). Off unless a test says otherwise, because
// most of them are about the cheap path.
export class FakeTranscriber extends PageTranscriber {
  configured = false;
  failing = false;
  readonly endpoint = 'http://transcriber.test';
  markdown = '';
  usage: TranscriptionUsage = {};
  readonly calls: Array<{ pages: number; languages: readonly string[] }> = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  // The provider being away (docs/05 §5.4e); the step around this is best-effort either way.
  unavailable = false;

  transcribe(
    pages: readonly PageImage[],
    languages: readonly string[],
  ): Promise<{ markdown: string; usage: TranscriptionUsage }> {
    this.calls.push({ pages: pages.length, languages });
    if (this.unavailable) {
      return Promise.reject(new ServiceUnavailableError('transcriber', 'fetch failed'));
    }
    if (this.failing) return Promise.reject(new Error('Transcriber request failed with 500'));
    return Promise.resolve({ markdown: this.markdown, usage: this.usage });
  }
}

export class FakeEmbeddingProvider extends EmbeddingProvider {
  readonly endpoint = 'http://embeddings.test';
  configured = true;
  failing = false;
  // Vectors are padded to this width; the real column is `vector(EMBEDDING_DIMENSIONS)`
  // (docs/04 §4.3), so anything writing to a database has to say so.
  dimensions = 3;
  // What the chunks will be stamped with (docs/03 §3.3.11).
  model = 'fake-embeddings';
  readonly batches: string[][] = [];

  get isConfigured(): boolean {
    return this.configured;
  }

  // The provider being away rather than refusing a batch (docs/05 §5.4e).
  unavailable = false;

  embed(texts: readonly string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    if (this.unavailable) {
      return Promise.reject(new ServiceUnavailableError('embeddings', 'fetch failed'));
    }
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
