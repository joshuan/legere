import { createHash } from 'node:crypto';
import type { DocumentDetailDto, Rotation } from '../../../shared/contracts/documents';
import type {
  CombineDocumentsRequest,
  CropSuggestionResponse,
  ReorderDocumentFilesRequest,
  SplitDocumentFileResponse,
  UpdateDocumentFileRequest,
} from '../../../shared/contracts/files';
import { canEditDocumentMeta } from '../../domain/entities/document';
import {
  entryOf,
  fileCropSourceOf,
  filePageOrderOf,
  filePageRotationsOf,
  fileTurnOf,
  orderedPages,
  pagesForFile,
  withFileCrop,
  withFilePageOrder,
  withFilePageTurns,
  withFileTurn,
  withInsertedAt,
  type PageEntry,
} from '../../domain/entities/document-page';
import { classifyFormat } from '../../domain/entities/document-format';
import {
  isImageFile,
  isPagePermutation,
  isPageRotationList,
  isPdfFile,
  type File,
} from '../../domain/entities/file';
import { detectPageEdges } from '../../domain/entities/page-detection';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  UnsupportedFormatError,
} from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type {
  DocumentDetail,
  DocumentFileView,
  DocumentRepository,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import { ContentHash } from '../../domain/value-objects/content-hash';
import { toBuffer } from '../ports/binary-source';
import type { Clock } from '../ports/clock';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { JobQueue } from '../ports/job-queue';
import type { MimeDetector } from '../ports/mime-detector';
import type { TransactionHandle, UnitOfWork } from '../ports/unit-of-work';
import { originalKeyOf, servableContentType } from '../storage/artifact-keys';
import type { DocumentFileBytes } from './document-file-bytes';
import { originOfDetail, toDetailDto } from './manage-documents';

// Composing a document out of files (docs/05 §5.6, docs/07 §7.3). Every use case here changes only
// which files a document holds, in what order and cropped how — nothing rewrites a file — and every
// one of them ends by enqueueing a rebuild, because a document whose pages changed is a different
// document to read, search and categorize.
//
// A change a person asked for outranks background work (docs/05 §5.4).
const USER_PRIORITY = 10;

// Enough bytes for magic-byte detection across the formats file-type recognises — the same head the
// library ingest reads.
const HEAD_BYTES = 4100;

// What the corner detector reads: detection wants shapes rather than detail, and a full-resolution
// photograph is a hundred times the work for the same four corners (docs/05 §5.6).
const DETECTION_MAX_DIM = 1200;

// A file arriving as the body of a request, its name in a header (docs/07 §7.3).
export type UploadedFile = {
  bytes: Buffer;
  fileName: string;
};

// POST /api/documents/:id/files?at= (docs/07 §7.3): the bytes are stored, deduplicated, and their
// pages put at a position — after the last page the document has unless the request names one, which
// is what puts a photograph between page two and page three of a five-page PDF (docs/05 §5.6).
export class AddDocumentFile {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly storage: FileStorage,
    private readonly mime: MimeDetector,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: UploadedFile,
    at?: number,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    // What the document holds now — and the list the position is a place in, which is the list the
    // caller was last answered with (docs/03 §3.3.17).
    const held = pagesOf(detail);
    // Refused before the bytes are read, let alone stored: a position past the end of the list is a
    // request about a document that does not exist (docs/07 §7.3).
    const where = at ?? held.length;
    if (where > held.length) {
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        `This document has ${held.length} pages, so there is no position ${where} to insert at`,
      );
    }
    const upload = await describeUpload(this.mime, input);

    const stored = await this.unitOfWork.run(async (tx) => {
      // The same bytes are one file however they arrive (ADR-021), and a file has exactly one home:
      // bytes that already belong somewhere are refused rather than moved, which is what Combine is
      // for (docs/05 §5.6).
      const { file, created } = await this.files.findOrCreateByContentHash(
        {
          contentHash: upload.contentHash,
          origin: 'MANAGED',
          // The key contains the id the row is about to be given, so it is recorded by whoever
          // knows it; `originalKeyOf` reads it back or falls back to the layout (docs/09 §9.2).
          storageKey: null,
          mimeType: upload.mimeType,
          ext: upload.ext,
          sizeBytes: BigInt(input.bytes.byteLength),
          name: input.fileName,
        },
        tx,
      );

      const home = await this.files.findDocumentIdForFile(file.id, tx);
      if (home !== null) {
        throw new ConflictError(
          'FILE_ALREADY_IN_DOCUMENT',
          'These bytes already belong to a document; combine the two documents instead',
        );
      }
      // Bytes that are in the trash are not refused: uploading them is a person saying they want
      // them back, and a file cannot be in a document and in the trash at once (docs/05 §5.7a).
      if (file.trashedAt !== null) await this.files.untrash(file.id, tx);

      // An append is still computed inside the transaction, from the last position the document
      // actually has, so the several files an upload panel sends at once cannot lose each other. An
      // insert at a chosen position cannot be: it is a rewrite of the whole list against the list the
      // caller was shown, and two of those race exactly as every other composition edit does
      // (docs/03 §3.3.17).
      if (at === undefined) await this.files.attach(documentId, file.id, tx);
      else
        await this.files.replacePages(documentId, withInsertedAt(held, at, pagesForFile(file)), tx);
      await this.events.record(
        {
          documentId,
          type: 'FILE_ATTACHED',
          actorId: viewer.id,
          // Where it landed as well as that it arrived: the position is the whole difference
          // between an append and an insert (docs/03 §3.3.18).
          payload: {
            source: 'UPLOAD',
            path: file.name,
            changes: { position: { from: null, to: String(where) } },
          },
        },
        tx,
      );
      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
      return { file, created };
    });

    if (stored.created) {
      // After the commit: an object written for a transaction that then rolled back would be an
      // orphan for maintenance to sweep (docs/09 §9.5).
      //
      // 🔒 Stored as what it may be served as, not as what it says it is (docs/09 §9.2); the row
      // keeps the detected MIME for everything that has to understand the file.
      await this.storage.put(
        originalKeyOf(stored.file),
        input.bytes,
        servableContentType(upload.mimeType),
      );
    }

    return reload(this.documents, viewer, documentId);
  }
}

// PATCH /api/documents/:id/files (docs/07 §7.3): the complete order, every file exactly once.
export class ReorderDocumentFiles {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: ReorderDocumentFilesRequest,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;

    // A partial order would leave the rest of the pages somewhere nobody chose, so an order that is
    // not a permutation of this document's own files is refused outright (docs/07 §7.3).
    const current = new Map(detail.files.map((file) => [file.id, file]));
    const asked = new Set(input.order);
    if (asked.size !== input.order.length || asked.size !== current.size) {
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        'The order must list every file of this document exactly once',
      );
    }
    for (const fileId of input.order) {
      if (!current.has(fileId)) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          'The order names a file that does not belong to this document',
        );
      }
    }

    await this.unitOfWork.run(async (tx) => {
      await this.files.reorder(documentId, input.order, tx);
      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            changes: {
              files: {
                from: detail.files.map((file) => file.name).join(', '),
                to: input.order.map((id) => current.get(id)?.name ?? id).join(', '),
              },
            },
          },
        },
        tx,
      );
      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
    });

    return reload(this.documents, viewer, documentId);
  }
}

// PATCH /api/documents/:id/files/:fileId (docs/07 §7.3): what one file says about itself — the
// quadrilateral its content sits in, which way up it lies, the order its own pages are read in and
// which way up each of those lies. All four are numbers written beside a file and never a change to
// its bytes (docs/03 §3.3.16); any may be sent alone, and any together are one edit and therefore
// one rebuild.
export class UpdateDocumentFile {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    fileId: string,
    input: UpdateDocumentFileRequest,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const file = fileOf(detail, fileId);
    const documentId = detail.document.id;

    // Every refusal before anything is written, so a body carrying one good half and one bad one
    // changes nothing at all rather than half of what it asked for.
    const crop = input.crop;
    if (crop !== undefined) assertImage(file);
    const rotation = input.rotation;
    if (rotation !== undefined) assertImage(file);
    const pageOrder = input.pageOrder;
    if (pageOrder !== undefined) assertPdf(file);
    if (pageOrder !== undefined && pageOrder !== null) assertPagesOf(file, pageOrder);
    const pageRotations = input.pageRotations;
    if (pageRotations !== undefined) assertPdf(file);
    if (pageRotations !== undefined && pageRotations !== null) {
      assertPageRotationsOf(file, pageRotations);
    }

    // What the document holds now, in order — every edit below answers with the list it should hold
    // instead, and the whole of it is written back once (docs/03 §3.3.17).
    const held = pagesOf(detail);

    await this.unitOfWork.run(async (tx) => {
      const changes: Record<string, { from?: string | null; to?: string | null }> = {};
      let pages: PageEntry[] = [...held];

      if (crop !== undefined) {
        // 🔒 A crop somebody dragged is theirs: MANUAL is what stops the next rebuild from replacing
        // it with what a detector found (docs/03 §3.3.17). Clearing it returns the page to NONE, so
        // the machine may answer again.
        const cropSource = crop === null ? 'NONE' : 'MANUAL';
        pages = withFileCrop(pages, fileId, crop, cropSource);
        changes.crop = { from: fileCropSourceOf(file.pages), to: cropSource };
      }

      if (rotation !== undefined) {
        pages = withFileTurn(pages, fileId, rotation);
        changes.rotation = {
          from: rotationLabel(fileTurnOf(file.pages)),
          to: rotationLabel(rotation),
        };
      }

      if (pageOrder !== undefined) {
        pages = withFilePageOrder(pages, fileId, pageOrder);
        changes.pageOrder = {
          from: pagesLabel(filePageOrderOf(file.pages, file.pageCount)),
          to: pagesLabel(pageOrder),
        };
      }

      if (pageRotations !== undefined) {
        pages = withFilePageTurns(pages, fileId, pageRotations);
        changes.pageRotations = {
          from: turnsLabel(filePageRotationsOf(file.pages, file.pageCount)),
          to: turnsLabel(pageRotations),
        };
      }

      await this.files.replacePages(documentId, pages, tx);

      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: { path: file.name, changes },
        },
        tx,
      );
      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
    });

    return reload(this.documents, viewer, documentId);
  }
}

// DELETE /api/documents/:id/files/:fileId (docs/07 §7.3): the file leaves and becomes a document of
// its own — never nothing (docs/05 §5.6).
export class SplitDocumentFile {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    fileId: string,
  ): Promise<SplitDocumentFileResponse> {
    assertMayCompose(viewer, detail);
    const file = fileOf(detail, fileId);
    const documentId = detail.document.id;

    if (detail.files.length <= 1) {
      // 🔒 A document is emptied by deleting it, not by taking its parts away one at a time
      // (docs/03 §3.3.10).
      throw new ConflictError(
        'DOCUMENT_LAST_FILE',
        'This is the only file of the document; delete the document instead',
      );
    }

    const splitDocumentId = await this.unitOfWork.run(async (tx) => {
      await this.files.detach(documentId, fileId, tx);

      // Titled after the file and inheriting nothing else: the split is a statement that these were
      // never one document, so carrying the type and people over would be an invention (docs/05 §5.6).
      const created = await this.documents.create(
        { title: titleOf(file.name), createdById: viewer.id },
        tx,
      );
      await this.files.attach(created.id, fileId, tx);

      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            path: file.name,
            changes: {
              files: { from: String(detail.files.length), to: String(detail.files.length - 1) },
            },
          },
        },
        tx,
      );
      await this.events.record(
        {
          documentId: created.id,
          type: 'CREATED',
          actorId: viewer.id,
          payload: { source: 'SPLIT', path: file.name },
        },
        tx,
      );
      await this.events.record(
        {
          documentId: created.id,
          type: 'FILE_ATTACHED',
          actorId: viewer.id,
          payload: { source: 'SPLIT', path: file.name },
        },
        tx,
      );

      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
      await enqueueRebuild(this.queue, this.events, tx, created.id, viewer.id);
      return created.id;
    });

    return { document: await reload(this.documents, viewer, documentId), splitDocumentId };
  }
}

// POST /api/documents/:id/files/:fileId/replacement (docs/07 §7.3): a better copy of one page takes
// the place of the one that is there (docs/05 §5.6).
//
// The difference from add-then-reorder is the whole point: a page re-photographed is still that
// page, so the new file inherits the old one's **position** and nothing else about the document
// moves. The old file is not destroyed either — it goes to the trash marked `REPLACED`, because the
// judgement "this scan is better" is exactly the kind somebody takes back an hour later
// (docs/05 §5.7a).
export class ReplaceDocumentFile {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly storage: FileStorage,
    private readonly mime: MimeDetector,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    fileId: string,
    input: UploadedFile,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    const replaced = fileOf(detail, fileId);
    const upload = await describeUpload(this.mime, input);

    if (upload.contentHash === replaced.contentHash) {
      // The same bytes cannot replace themselves: there would be one file, in the trash and in the
      // document at once, which is the one thing §3.3.16 does not allow.
      throw new ConflictError(
        'FILE_ALREADY_IN_DOCUMENT',
        'These are the bytes already in that place',
      );
    }

    const stored = await this.unitOfWork.run(async (tx) => {
      const { file, created } = await this.files.findOrCreateByContentHash(
        {
          contentHash: upload.contentHash,
          origin: 'MANAGED',
          storageKey: null,
          mimeType: upload.mimeType,
          ext: upload.ext,
          sizeBytes: BigInt(input.bytes.byteLength),
          name: input.fileName,
        },
        tx,
      );

      // The same bytes are one file (ADR-021), so what arrives may be a file that already exists.
      // A file with a home is refused, as an upload is — moving it is Combine. A file in the trash
      // is not refused: it is taken back out, which is what "the version I replaced was better
      // after all" comes down to (docs/05 §5.6).
      const home = await this.files.findDocumentIdForFile(file.id, tx);
      if (home !== null) {
        throw new ConflictError(
          'FILE_ALREADY_IN_DOCUMENT',
          'These bytes already belong to a document; combine the two documents instead',
        );
      }
      if (file.trashedAt !== null) await this.files.untrash(file.id, tx);

      // Out of the composition and into the trash, then in at the same position: the two are one
      // move, and a file may not be read by two documents through this route, so the order is forced.
      await this.files.detach(documentId, fileId, tx);
      await this.files.trash(
        {
          fileIds: [fileId],
          reason: 'REPLACED',
          trashedFrom: detail.document.title,
          replacedById: file.id,
          at: this.clock.now(),
        },
        tx,
      );
      await this.files.attach(documentId, file.id, tx);
      await this.files.reorder(
        documentId,
        detail.files.map((held) => (held.id === fileId ? file.id : held.id)),
        tx,
      );

      await this.events.record(
        {
          documentId,
          type: 'FILE_ATTACHED',
          actorId: viewer.id,
          payload: { source: 'UPLOAD', path: file.name },
        },
        tx,
      );
      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
      return { file, created };
    });

    if (stored.created) {
      // After the commit, for the reason the upload gives: an object written for a transaction that
      // rolled back is an orphan (docs/09 §9.5).
      await this.storage.put(
        originalKeyOf(stored.file),
        input.bytes,
        servableContentType(upload.mimeType),
      );
    }

    return reload(this.documents, viewer, documentId);
  }
}

// POST /api/documents/:id/combine (docs/07 §7.3): several documents become one. This is what "these
// two scans are one document" means, and it is what replaced the scan sets (docs/05 §5.6).
export class CombineDocuments {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: CombineDocumentsRequest,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const targetId = detail.document.id;

    const seen = new Set<string>();
    const sources: DocumentDetail[] = [];
    for (const documentId of input.documentIds) {
      if (documentId === targetId) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          'A document cannot be combined into itself',
        );
      }
      if (seen.has(documentId)) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          'The same document is named twice in one combine',
        );
      }
      seen.add(documentId);

      // 🔒 Reading is not enough: absorbing a document destroys it as a document, so the caller must
      // be able to edit every one of them (docs/03 §3.4).
      const source = await this.documents.findReadableById(documentId, viewer);
      if (source === null) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
      assertMayCompose(viewer, source);
      sources.push(source);
    }

    await this.unitOfWork.run(async (tx) => {
      const deletedAt = this.clock.now();
      for (const source of sources) {
        // In the order the caller chose, and inside one document in its own page order: the files
        // are appended, so the target keeps its own pages first.
        const moving = await this.files.listForDocument(source.document.id, tx);
        for (const file of moving) {
          await this.files.detach(source.document.id, file.id, tx);
          await this.files.attach(targetId, file.id, tx);
          await this.events.record(
            {
              documentId: targetId,
              type: 'FILE_ATTACHED',
              actorId: viewer.id,
              payload: { source: 'COMBINE', path: file.name },
            },
            tx,
          );
        }

        // The emptied row goes away with its own title, type, people and collections: they belonged
        // to a document that no longer exists, and the target keeps what it had (docs/05 §5.6).
        await this.documents.softDelete(source.document.id, deletedAt, tx);
        await this.events.record(
          {
            documentId: source.document.id,
            type: 'META_CHANGED',
            actorId: viewer.id,
            payload: {
              changes: { combinedInto: { from: source.document.title, to: detail.document.title } },
            },
          },
          tx,
        );
      }

      await enqueueRebuild(this.queue, this.events, tx, targetId, viewer.id);
    });

    return reload(this.documents, viewer, targetId);
  }
}

// GET /api/documents/:id/files/:fileId/crop-suggestion (docs/07 §7.3). Edge detection over the
// photograph, and the content bounding box when it finds no page. A **proposal**: it lands in the
// editor for a person to accept or drag, and nothing is stored until they save (docs/05 §5.6).
export class SuggestDocumentFileCrop {
  constructor(
    private readonly bytes: DocumentFileBytes,
    private readonly images: ImageTool,
  ) {}

  async execute(detail: DocumentDetail, fileId: string): Promise<CropSuggestionResponse> {
    const file = fileOf(detail, fileId);
    assertImage(file);

    // Read once and held: the detector and the fallback both want the same bytes, and a stream is
    // good for one of them.
    const source = await toBuffer(await this.bytes.open(file));

    const raster = await this.images.grayscaleRaster(source, DETECTION_MAX_DIM);
    const detected = detectPageEdges(raster);
    if (detected !== null) return { crop: detected.crop, method: detected.method };

    // A page filling the frame edge to edge, or a photograph of nothing: the honest answer is what
    // is actually on the image, which is what earlier releases applied unconditionally.
    return { crop: await this.images.contentBox(source), method: 'CONTENT_BOX' };
  }
}

// 🔒 Who may change what a document is made of: the same rule as its title and type (docs/03 §3.4).
export function assertMayCompose(viewer: Viewer, detail: DocumentDetail): void {
  if (!canEditDocumentMeta(viewer, detail.document, originOfDetail(detail))) {
    throw new ForbiddenError('You may not edit this document');
  }
}

// The whole ordered list a document holds, read back off its detail: the pages of every file, in
// the order the document holds them (docs/03 §3.3.17). Every composition edit answers with a list
// like this one and writes it back in a single rewrite.
export function pagesOf(detail: DocumentDetail): PageEntry[] {
  return orderedPages(detail.files).map(entryOf);
}

export function fileOf(detail: DocumentDetail, fileId: string): DocumentFileView {
  const file = detail.files.find((candidate) => candidate.id === fileId);
  if (file === undefined) {
    throw new NotFoundError('FILE_NOT_FOUND', 'This document has no such file');
  }
  return file;
}

// Only an image carries a crop, and only an image is turned as one picture: a PDF page is already a
// page, there is nothing to straighten, and its pages are turned one at a time (docs/05 §5.6).
export function assertImage(file: Pick<File, 'mimeType'>): void {
  if (!isImageFile(file)) {
    throw new UnprocessableError(
      'FILE_NOT_IMAGE',
      'Only an image file can be cropped or turned as one picture',
    );
  }
}

// And the other way round: only a PDF has pages to put in order and to turn one at a time. An image
// is one page and a format nothing renders is none (docs/03 §3.3.16).
export function assertPdf(file: Pick<File, 'mimeType'>): void {
  if (!isPdfFile(file)) {
    throw new UnprocessableError(
      'FILE_NOT_PDF',
      'Only a PDF file has pages to put in order and to turn',
    );
  }
}

// The order names every page of *this* file, exactly once. What "every page" means is the count the
// last canonical build wrote down (docs/05 §5.5 step 1): a file no build has opened yet takes no
// order at all, because there is nothing to check one against and an unchecked permutation is a
// canonical built out of pages that do not exist (docs/07 §7.3).
export function assertPagesOf(file: Pick<File, 'pageCount'>, order: readonly number[]): void {
  if (file.pageCount === null) {
    throw new UnprocessableError(
      'VALIDATION_FAILED',
      'Nothing has counted the pages of this file yet, so an order for them cannot be checked',
    );
  }
  if (!isPagePermutation(order, file.pageCount)) {
    throw new UnprocessableError(
      'VALIDATION_FAILED',
      `The order must name each of the ${file.pageCount} pages of this file exactly once`,
    );
  }
}

// And the same for a list of turns: one turn per page, in degrees clockwise, which is how a person
// says it out loud (docs/07 §7.3).
export function assertPageRotationsOf(
  file: Pick<File, 'pageCount'>,
  rotations: readonly number[],
): void {
  if (file.pageCount === null) {
    throw new UnprocessableError(
      'VALIDATION_FAILED',
      'Nothing has counted the pages of this file yet, so turns for them cannot be checked',
    );
  }
  if (!isPageRotationList(rotations, file.pageCount)) {
    throw new UnprocessableError(
      'VALIDATION_FAILED',
      `The turns must name each of the ${file.pageCount} pages of this file exactly once`,
    );
  }
}

// A page order as the journal reads it: the pages counted the way a person counts them, from one.
// `null` for a file that has none, which is what the log should say rather than a word invented for
// it (docs/03 §3.3.18).
function pagesLabel(order: readonly number[] | null): string | null {
  return order === null ? null : order.map((index) => index + 1).join(', ');
}

// A turn as the journal reads it: degrees clockwise, and the mirror said in words where there is
// one. `null` for a file that reads the way it arrived.
function rotationLabel(rotation: Rotation | null): string | null {
  if (rotation === null) return null;
  const degrees = `${rotation.quarterTurns * 90}°`;
  return rotation.mirrored ? `${degrees} mirrored` : degrees;
}

function turnsLabel(rotations: readonly number[] | null): string | null {
  return rotations === null ? null : rotations.map((turn) => `${turn * 90}°`).join(', ');
}

// The composition changed, so the canonical PDF and everything read off it are stale. The old
// artifacts are left where they are until the new ones are written, so the document keeps reading
// while it rebuilds (docs/05 §5.6).
export async function enqueueRebuild(
  queue: JobQueue,
  events: DocumentEventRepository,
  tx: TransactionHandle,
  documentId: string,
  actorId: string,
): Promise<void> {
  await queue.enqueueAfterTx(tx, 'document-process', { documentId }, { priority: USER_PRIORITY });
  await events.record({ documentId, type: 'QUEUED', actorId }, tx);
}

// Every composition route answers with the whole document: a change to one file moves positions,
// availability and the origin of the document itself, so anything less would be a lie (docs/07 §7.3).
export async function reload(
  documents: DocumentRepository,
  viewer: Viewer,
  documentId: string,
): Promise<DocumentDetailDto> {
  const detail = await documents.findReadableById(documentId, viewer);
  if (detail === null) throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
  return toDetailDto(detail);
}

export type DescribedUpload = {
  contentHash: string;
  mimeType: string;
  ext: string;
};

// What the bytes are, before anything is written: content decides the format, exactly as during
// ingest — a `.pdf` that is really a JPEG is a JPEG (docs/03 §3.3.16).
export async function describeUpload(
  mime: MimeDetector,
  input: UploadedFile,
): Promise<DescribedUpload> {
  if (input.bytes.byteLength === 0) {
    throw new UnprocessableError('VALIDATION_FAILED', 'The uploaded file is empty');
  }
  const contentHash = ContentHash.parse(createHash('sha256').update(input.bytes).digest('hex'));
  const detected = await mime.detect(input.bytes.subarray(0, HEAD_BYTES), input.fileName);
  // 🔒 Refused at the door, before anything is stored: an upload the pipeline could never render
  // would be a document of nothing but skipped steps (docs/05 §5.1a). The gate is the very
  // classification the canonical build branches on (§5.5 step 1), so what is accepted and what
  // becomes pages cannot drift apart. A library scan stays tolerant — it has nobody to answer.
  if (classifyFormat(detected.mime) === 'UNSUPPORTED') {
    throw new UnsupportedFormatError();
  }
  return {
    contentHash: contentHash.value,
    mimeType: detected.mime,
    ext: detected.ext === '' ? extensionOf(input.fileName) : detected.ext,
  };
}

// "Contract 2026.pdf" → "Contract 2026"; a name with no extension keeps all of itself.
export function titleOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function extensionOf(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
