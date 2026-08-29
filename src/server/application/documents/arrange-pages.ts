import type { DocumentDetailDto } from '../../../shared/contracts/documents';
import type { ValueSource } from '../../../shared/contracts/enums';
import type {
  MoveDocumentPagesRequest,
  MoveDocumentPagesResponse,
  ReorderDocumentPagesRequest,
  SplitDocumentRequest,
  SplitDocumentResponse,
  UpdateDocumentPageRequest,
} from '../../../shared/contracts/files';
import { orderedPair } from '../../domain/entities/document-link';
import {
  withPageCrop,
  withPageTurn,
  withoutId,
  type DocumentPage,
  type PageEntry,
} from '../../domain/entities/document-page';
import { NotFoundError, UnprocessableError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentLinkRepository } from '../../domain/repositories/document-link.repository';
import type {
  DocumentDetail,
  DocumentFileView,
  DocumentRepository,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { Clock } from '../ports/clock';
import type { JobQueue } from '../ports/job-queue';
import type { UnitOfWork } from '../ports/unit-of-work';
import {
  assertKeepsItsReaders,
  assertMayCompose,
  assertMayDestroy,
  assertMayMirror,
  enqueueRebuild,
  originsOfPages,
  pagesOf,
  reload,
  rotationLabel,
  titleOf,
  trashFilesNothingReads,
} from './compose-document';

// A document worked on by the page (docs/05 §5.6, docs/07 §7.3, ADR-025). Everything here addresses
// **entries** — which page of which file stands where, which way up it lies and how much of it is
// paper — and nothing here touches a byte: a split is the entries of one document dividing between
// two over the *same* files, a move is entries changing hands, and a crop is four numbers written
// beside one of them. The library is read-only (ADR-007) and an original stays the original.
//
// Every one of them rewrites a document's whole list in one statement and ends by enqueueing the
// rebuild every composition change enqueues, because a document whose pages changed is a different
// document to read, search and categorize.

// How long a journal entry may spell an order out for. A permutation of two thousand pages written
// into a payload is a log nobody reads and a row nobody wanted; past this the entry says how the
// order begins and how many pages it holds.
const ORDER_LABEL_LIMIT = 40;

// PATCH /api/documents/:id/pages (docs/07 §7.3): the complete order, every page of this document
// exactly once. One request and one truth — a page moved to a position is this request carrying the
// order that results from it, which is the only shape that cannot be half applied (docs/05 §5.6).
export class ReorderDocumentPages {
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
    input: ReorderDocumentPagesRequest,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    const held = pagesOf(detail);

    // A partial order would leave the rest of the pages somewhere nobody chose, so an order that is
    // not a permutation of this document's own entries is refused outright (docs/07 §7.3).
    const byId = new Map(held.flatMap((page) => (page.id === undefined ? [] : [[page.id, page]])));
    const asked = new Set(input.order);
    if (asked.size !== input.order.length || asked.size !== byId.size) {
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        'The order must list every page of this document exactly once',
      );
    }
    const at = new Map(held.map((page, index) => [page.id, index]));
    const reordered: PageEntry[] = [];
    for (const pageId of input.order) {
      const page = byId.get(pageId);
      if (page === undefined) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          'The order names a page that does not belong to this document',
        );
      }
      reordered.push(page);
    }

    await this.unitOfWork.run(async (tx) => {
      await this.files.replacePages(documentId, { pages: reordered, expecting: held }, tx);
      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            changes: {
              pages: {
                from: orderLabel(held.map((unused, index) => index)),
                to: orderLabel(input.order.map((pageId) => at.get(pageId) ?? 0)),
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

// PATCH /api/documents/:id/pages/:pageId (docs/07 §7.3): how one page lies and how much of it is
// paper (docs/03 §3.3.17). Both may be sent alone and both together are one edit and therefore one
// rebuild, which is what the crop editor sends — "which part of this" and "which way up" being one
// question about one page (docs/11 §11.5c).
//
// 🔒 A crop is taken on **any** page, an image's or a PDF's, because the build honours it on either:
// the page is rendered and warped exactly as a photograph is (docs/05 §5.5 step 1). Only the mirror
// is an image's own — a page of a PDF arrives the way its producer laid it out and turns in
// quarters.
export class UpdateDocumentPage {
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
    pageId: string,
    input: UpdateDocumentPageRequest,
  ): Promise<DocumentDetailDto> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    const target = pageOf(detail, pageId);

    // Every refusal before anything is written, so a body carrying one good half and one bad one
    // changes nothing at all rather than half of what it asked for.
    const { crop, turn } = input;
    if (turn !== undefined && turn !== null && turn.mirrored) assertMayMirror(target.file);

    // What the document holds now, in order — the edits below answer with the list it should hold
    // instead, and the whole of it is written back once (docs/03 §3.3.17).
    const held = pagesOf(detail);

    await this.unitOfWork.run(async (tx) => {
      const changes: Record<string, { from?: string | null; to?: string | null }> = {};
      let pages: PageEntry[] = [...held];

      if (crop !== undefined) {
        // 🔒 A crop somebody dragged is theirs: MANUAL is what stops the next rebuild from replacing
        // it with what a detector found (docs/03 §3.3.17). Clearing it returns the page to NONE, so
        // the machine may answer again.
        const cropSource: ValueSource = crop === null ? 'NONE' : 'MANUAL';
        pages = withPageCrop(pages, pageId, crop, cropSource);
        changes.crop = { from: target.page.cropSource, to: cropSource };
      }

      if (turn !== undefined) {
        pages = withPageTurn(pages, pageId, turn);
        changes.turn = { from: rotationLabel(target.page.turn), to: rotationLabel(turn) };
      }

      await this.files.replacePages(documentId, { pages, expecting: held }, tx);
      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          // Which page of which paper, counted the way a person counts them: the file's name and
          // the page's own place in the document (docs/03 §3.3.18).
          payload: { path: `${target.file.name} · ${target.page.position + 1}`, changes },
        },
        tx,
      );
      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
    });

    return reload(this.documents, viewer, documentId);
  }
}

// DELETE /api/documents/:id/pages/:pageId (docs/07 §7.3): one entry leaves and the rest close up
// behind it. 🔒 The file it was read from goes to the trash only if no live page anywhere still
// reads it — the rule of `05 §5.7a`, one join further out since ADR-025.
//
// 🔒 This is the one page operation that **destroys** (docs/03 §3.4a): the entry is gone, and with it
// possibly the file, into a trash only an admin can reach and with its library refs EXCLUDED so the
// next scan will not bring the bytes back. So it is not an arranging right — a reader of a library
// document who wants a page out of it **moves** it, which leaves it read somewhere else and takes
// nothing from anybody.
export class RemoveDocumentPage {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    pageId: string,
  ): Promise<DocumentDetailDto> {
    assertMayDestroy(viewer, detail);
    const documentId = detail.document.id;
    const held = pagesOf(detail);

    const removed = held.find((page) => page.id === pageId);
    if (removed === undefined) {
      throw new NotFoundError('PAGE_NOT_FOUND', 'This document has no such page');
    }
    if (held.length <= 1) {
      // 🔒 A document is emptied by deleting it, not by taking its pages away one at a time
      // (docs/03 §3.3.10).
      throw new UnprocessableError(
        'DOCUMENT_LAST_PAGE',
        'This is the only page of the document; delete the document instead',
      );
    }
    const kept = held.filter((page) => page.id !== pageId);
    // 🔒 And what is left has to be readable by somebody (docs/03 §3.4a): taking the last page that
    // reads a library file out of a document a scan made would leave it in the database and nowhere
    // else.
    assertKeepsItsReaders(detail.document.createdById, originsOfPages(kept, detail));
    const file = detail.files.find((candidate) => candidate.id === removed.fileId);

    await this.unitOfWork.run(async (tx) => {
      await this.files.replacePages(documentId, { pages: kept, expecting: held }, tx);
      await trashFilesNothingReads(
        { files: this.files, fileRefs: this.fileRefs, clock: this.clock },
        [removed.fileId],
        detail.document.title,
        tx,
      );
      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            ...(file === undefined ? {} : { path: file.name }),
            changes: {
              pages: { from: String(held.length), to: String(held.length - 1) },
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

// POST /api/documents/:id/split (docs/07 §7.3): the twenty-page scan whose eighth page begins
// another contract becomes two documents and no new bytes (docs/05 §5.6).
//
// 🔒 Nothing is extracted and nothing is copied. The entries divide between the parts and every one
// of them keeps naming the file it always named, so one file is simply read by pages in two places —
// which is what ADR-025 decided and what a page splitter was refused for.
export class SplitDocumentAtPages {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly links: DocumentLinkRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: SplitDocumentRequest,
  ): Promise<SplitDocumentResponse> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    const held = pagesOf(detail);

    // Every part has to be a document, and a document has at least one page (docs/03 §3.3.10): a cut
    // at the first page would make an empty one, and a cut past the last would make a part out of
    // nothing. Both are the request's own arithmetic against the list it was just shown.
    const boundaries = [...new Set(input.at)].sort((a, b) => a - b);
    if (boundaries.length !== input.at.length) {
      throw new UnprocessableError('VALIDATION_FAILED', 'The same page boundary is named twice');
    }
    for (const boundary of boundaries) {
      if (boundary >= held.length) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          `This document has ${held.length} pages, so there is no page ${boundary} to cut at`,
        );
      }
    }

    // The first part stays where it is; each later one becomes a document of its own.
    const parts: PageEntry[][] = [];
    let from = 0;
    for (const boundary of [...boundaries, held.length]) {
      parts.push(held.slice(from, boundary));
      from = boundary;
    }
    const [kept, ...cut] = parts;
    if (kept === undefined || cut.length === 0) {
      throw new UnprocessableError('VALIDATION_FAILED', 'A split has to cut somewhere');
    }

    // 🔒 Every part has to be a document somebody can read, and each of them takes the original's
    // owner — which for a document a scan made is nobody, so a part that keeps no library page keeps
    // no readers either (docs/03 §3.4a). Asked of all of them, before any of them exists.
    for (const part of parts) {
      assertKeepsItsReaders(detail.document.createdById, originsOfPages(part, detail));
    }

    const splitDocumentIds = await this.unitOfWork.run(async (tx) => {
      const at = this.clock.now();
      const made: string[] = [];

      for (const part of cut) {
        // 🔒 The original's **owner** and nothing it has not earned: no title but the name of the
        // file its first page comes from, no type, no people, no collections. Half a paper is not
        // the paper, and the pipeline reads it afresh (docs/05 §5.6).
        const created = await this.documents.create(
          {
            title: titleOf(nameOfFirstFile(detail, part)),
            createdById: detail.document.createdById,
          },
          tx,
        );
        // The entries change hands: written afresh in their new document, since a page id addresses
        // an entry inside the document that holds it and this is a different one (docs/03 §3.3.17).
        await this.files.replacePages(
          created.id,
          { pages: part.map(withoutId), expecting: null },
          tx,
        );
        await this.events.record(
          {
            documentId: created.id,
            type: 'CREATED',
            actorId: viewer.id,
            payload: {
              source: 'SPLIT',
              otherDocumentId: documentId,
              otherTitle: detail.document.title,
            },
          },
          tx,
        );
        made.push(created.id);
      }

      await this.files.replacePages(documentId, { pages: kept, expecting: held }, tx);
      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            source: 'SPLIT',
            changes: { pages: { from: String(held.length), to: String(kept.length) } },
          },
        },
        tx,
      );

      // The parts are linked to each other and to the original (ADR-023): what makes them
      // separate-but-together, and what lets a reader of one part find the rest from where they are.
      const everyPart = [documentId, ...made];
      const titles = new Map<string, string>([[documentId, detail.document.title]]);
      for (const [index, id] of made.entries()) {
        titles.set(id, titleOf(nameOfFirstFile(detail, cut[index] ?? [])));
      }
      for (const [index, one] of everyPart.entries()) {
        for (const other of everyPart.slice(index + 1)) {
          await this.links.create(orderedPair(one, other), viewer.id, at, tx);
          await this.events.record(
            {
              documentId: one,
              type: 'LINKED',
              actorId: viewer.id,
              payload: { otherDocumentId: other, otherTitle: titles.get(other) ?? '' },
            },
            tx,
          );
          await this.events.record(
            {
              documentId: other,
              type: 'LINKED',
              actorId: viewer.id,
              payload: { otherDocumentId: one, otherTitle: titles.get(one) ?? '' },
            },
            tx,
          );
        }
      }

      for (const id of everyPart) {
        await enqueueRebuild(this.queue, this.events, tx, id, viewer.id);
      }
      return made;
    });

    return { document: await reload(this.documents, viewer, documentId), splitDocumentIds };
  }
}

// POST /api/documents/:id/pages/move (docs/07 §7.3): the page that belongs elsewhere goes there
// instead of being scanned again (docs/05 §5.6). The entries leave one list and join the other; the
// bytes do not move, because they were never in a document to begin with.
export class MoveDocumentPages {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: MoveDocumentPagesRequest,
  ): Promise<MoveDocumentPagesResponse> {
    assertMayCompose(viewer, detail);
    const documentId = detail.document.id;
    const held = pagesOf(detail);

    if (input.documentId === documentId) {
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        'A page cannot be moved into the document it is already in',
      );
    }

    // 🔒 Every refusal before anything is written, because a move is refused **whole** or done
    // whole: half a move is a page in neither document or in both (docs/05 §5.6).
    const asked = new Set(input.pageIds);
    if (asked.size !== input.pageIds.length) {
      throw new UnprocessableError('VALIDATION_FAILED', 'The same page is named twice');
    }
    const byId = new Map(held.flatMap((page) => (page.id === undefined ? [] : [[page.id, page]])));
    const moving: PageEntry[] = [];
    for (const pageId of input.pageIds) {
      const page = byId.get(pageId);
      if (page === undefined) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          'One of those pages does not belong to this document',
        );
      }
      moving.push(page);
    }
    const remaining = held.filter((page) => page.id === undefined || !asked.has(page.id));
    if (remaining.length === 0) {
      throw new UnprocessableError(
        'DOCUMENT_LAST_PAGE',
        'That would leave this document with no pages; delete it instead',
      );
    }

    // 🔒 Read access decides whether the target exists as far as this caller is concerned, and the
    // edit right decides whether they may put anything in it — the same two questions a link asks of
    // its other end (docs/03 §3.4).
    const target =
      input.documentId === null
        ? null
        : await this.documents.findReadableById(input.documentId, viewer);
    if (input.documentId !== null && target === null) {
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }
    if (target !== null) assertMayCompose(viewer, target);

    // 🔒 Both ends keep their readers (docs/03 §3.4a). The source may not be stripped of the last
    // page that reads a library file, and a **new** document made to hold the movers takes this
    // document's owner — nobody, for a document a scan made — so it has to hold one itself. Moving
    // into an existing document cannot take readers from it: it only gains pages.
    assertKeepsItsReaders(detail.document.createdById, originsOfPages(remaining, detail));
    if (target === null) {
      assertKeepsItsReaders(detail.document.createdById, originsOfPages(moving, detail));
    }

    const targetHeld = target === null ? [] : pagesOf(target);
    const at = input.at ?? targetHeld.length;
    if (at > targetHeld.length) {
      throw new UnprocessableError(
        'VALIDATION_FAILED',
        `That document has ${targetHeld.length} pages, so there is no position ${at} to move into`,
      );
    }

    const movedToDocumentId = await this.unitOfWork.run(async (tx) => {
      // The source first: the entries are deleted there before they are written here, so a page id
      // is never held by two documents at once — and they are written afresh, since an id addresses
      // an entry inside the document that holds it (docs/03 §3.3.17).
      await this.files.replacePages(documentId, { pages: remaining, expecting: held }, tx);

      const into =
        target === null
          ? await this.documents.create(
              {
                title: titleOf(nameOfFirstFile(detail, moving)),
                // The source's owner, exactly as a split's parts take the original's (docs/05 §5.6).
                createdById: detail.document.createdById,
              },
              tx,
            )
          : target.document;
      const before = targetHeld.length;
      await this.files.replacePages(
        into.id,
        {
          pages: [...targetHeld.slice(0, at), ...moving.map(withoutId), ...targetHeld.slice(at)],
          // A document made a moment ago inside this transaction has the list we just wrote; an
          // existing target was read before the handler, so its reading is named like any other.
          expecting: target === null ? null : targetHeld,
        },
        tx,
      );

      // 🔒 Asked all the same: a page that moved is still read, so in the ordinary case nothing goes
      // to the trash — but the rule is "a file with no live page anywhere" and it is answered by the
      // database rather than by an assumption about which edits can bite (docs/05 §5.7a).
      await trashFilesNothingReads(
        { files: this.files, fileRefs: this.fileRefs, clock: this.clock },
        [...new Set(moving.map((page) => page.fileId))],
        detail.document.title,
        tx,
      );

      await this.events.record(
        {
          documentId,
          type: 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            source: 'MOVE',
            otherDocumentId: into.id,
            otherTitle: into.title,
            changes: { pages: { from: String(held.length), to: String(remaining.length) } },
          },
        },
        tx,
      );
      await this.events.record(
        {
          documentId: into.id,
          type: target === null ? 'CREATED' : 'META_CHANGED',
          actorId: viewer.id,
          payload: {
            source: 'MOVE',
            otherDocumentId: documentId,
            otherTitle: detail.document.title,
            changes: { pages: { from: String(before), to: String(before + moving.length) } },
          },
        },
        tx,
      );

      await enqueueRebuild(this.queue, this.events, tx, documentId, viewer.id);
      await enqueueRebuild(this.queue, this.events, tx, into.id, viewer.id);
      return into.id;
    });

    return { document: await reload(this.documents, viewer, documentId), movedToDocumentId };
  }
}

// One entry of this document, with the file it is read from — which is what says whether it may be
// mirrored, and what the journal calls it. A page id addresses an entry inside the document that
// holds it, so a page of another document is simply not there (docs/03 §3.3.17).
function pageOf(
  detail: DocumentDetail,
  pageId: string,
): { page: DocumentPage; file: DocumentFileView } {
  const found = detail.files.flatMap((file) =>
    file.pages.flatMap((page) => (page.id === pageId ? [{ page, file }] : [])),
  );
  const one = found[0];
  if (one === undefined) {
    throw new NotFoundError('PAGE_NOT_FOUND', 'This document has no such page');
  }
  return one;
}

// What a part is called before anything reads it: the name of the file its first page comes from,
// exactly as a file split off becomes a document named after itself (docs/05 §5.6). Empty where the
// detail no longer describes that file, which leaves the pipeline to name it.
function nameOfFirstFile(detail: DocumentDetail, part: readonly PageEntry[]): string {
  const first = part[0];
  if (first === undefined) return '';
  return detail.files.find((file) => file.id === first.fileId)?.name ?? '';
}

// An order as the journal reads it: where each page stood before, counted the way a person counts
// them, from one. Long orders are cut short — the entry exists so somebody can see *that* the pages
// moved and roughly how, and a two-thousand-page permutation in a payload is neither.
function orderLabel(positions: readonly number[]): string {
  const shown = positions.slice(0, ORDER_LABEL_LIMIT).map((position) => position + 1);
  return positions.length > ORDER_LABEL_LIMIT
    ? `${shown.join(', ')}, … (${positions.length} pages)`
    : shown.join(', ');
}
