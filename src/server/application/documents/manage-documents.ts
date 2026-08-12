import {
  MAX_DOCUMENT_GROUPS,
  type DocumentDetailDto,
  type DocumentEventPage,
  type DocumentFileDto,
  type DocumentGroupsResponse,
  type DocumentYearsResponse,
  type DocumentListDto,
  type ListDocumentGroupsQuery,
  type ListDocumentsQuery,
  type ListDocumentsResponse,
  type UpdateDocumentRequest,
} from '../../../shared/contracts/documents';
import type { FileOrigin } from '../../../shared/contracts/enums';
import {
  availabilityOf,
  canEditDocumentMeta,
  isProcessing,
  originOf,
  type Document,
} from '../../domain/entities/document';
import { isImageFile } from '../../domain/entities/file';
import type { DocumentEventPayload } from '../../domain/entities/document-event';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { PersonRepository } from '../../domain/repositories/person.repository';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import { ForbiddenError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentTypeRepository } from '../../domain/repositories/document-type.repository';
import type {
  DocumentDetail,
  DocumentFileView,
  DocumentListItem,
  DocumentRepository,
  UpdateDocumentMetaInput,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { Clock } from '../ports/clock';
import { originalKeyOf } from '../storage/artifact-keys';

// GET /api/documents (docs/07 §7.3). The filter set is fixed and the access rule lives in the
// query, so a page of thirty is thirty documents this caller may actually read.
export class ListDocuments {
  constructor(private readonly documents: DocumentRepository) {}

  async execute(viewer: Viewer, query: ListDocumentsQuery): Promise<ListDocumentsResponse> {
    const page = await this.documents.listReadable(viewer, query);
    return { items: page.items.map(toListDto), nextCursor: page.nextCursor };
  }
}

// GET /api/documents/:id. The guard has already loaded the document; this only shapes it.
export class GetDocument {
  execute(detail: DocumentDetail): DocumentDetailDto {
    return toDetailDto(detail);
  }
}

// PATCH /api/documents/:id (docs/07 §7.3): title and documentType, per canEditDocumentMeta.
// The history of one document (docs/03 §3.3.18). Access is the document's own: whoever may read it
// may read how it came to be what it is.
export class ListDocumentEvents {
  constructor(private readonly events: DocumentEventRepository) {}

  async execute(
    documentId: string,
    query: { limit: number; cursor?: string | undefined; asAdmin?: boolean },
  ): Promise<DocumentEventPage> {
    const page = await this.events.listForDocument(documentId, query);
    return {
      items: page.items.map((event) => ({
        id: event.id,
        type: event.type,
        at: event.at.toISOString(),
        actor: event.actorName,
        payload: query.asAdmin === true ? event.payload : redactForReader(event.payload),
      })),
      nextCursor: page.nextCursor,
    };
  }
}

// 🔒 What an entry says to somebody who does not administer this instance (docs/03 §3.3.18,
// docs/08 §8.5). The service and the id are everybody's — they say who did the work and under what
// name. The host it lives on is stripped for anyone who cannot act on it, and a path inside a
// library is stripped for the same reason the document's own `refs` are filtered to visible
// libraries: files are deduplicated instance-wide, so an entry can name a folder inside a library
// this reader was never granted, and the log must not say what `GET /api/documents/:id` refuses to.
// Blunt on purpose — it also drops the path for a reader who could have seen that library. The
// better end state is to filter the entry by the library it names, which waits for the payload to
// carry its `libraryId` (a forward-only change, with older rows falling back to redacted).
function redactForReader(payload: DocumentEventPayload): DocumentEventPayload {
  const withoutEndpoint = { ...payload, endpoint: undefined };
  // Only a library path is somebody else's folder: an upload, a split or a combine names a file of
  // ours, which the reader is looking at anyway.
  return payload.source === 'LIBRARY' ? { ...withoutEndpoint, path: undefined } : withoutEndpoint;
}

// The years a shelf has documents in, newest first: the folders of a cabinet arranged by date
// (docs/11 §11.4).
export class ListDocumentYears {
  constructor(private readonly documents: DocumentRepository) {}

  async execute(viewer: Viewer): Promise<DocumentYearsResponse> {
    return { items: await this.documents.listYears(viewer) };
  }
}

// GET /api/documents/groups (docs/07 §7.3): the shelves of one dimension, under the filters in
// force. Not a page of documents and not paginated — a group's contents are the ordinary list
// filtered by that group's key, which is why every dimension offered is one the list can filter by.
export class ListDocumentGroups {
  constructor(private readonly documents: DocumentRepository) {}

  async execute(viewer: Viewer, query: ListDocumentGroupsQuery): Promise<DocumentGroupsResponse> {
    const { by, ...filters } = query;
    const groups = await this.documents.countByGroup(viewer, by, filters);

    // The fullest shelf first — that is where the archive actually is — with the label breaking a
    // tie so two runs of the same question answer in the same order. The cap is what keeps an
    // aggregate over an unbounded dimension (a city, a person) a bounded answer (docs/07 §7.1).
    const named = groups.filter((group) => group.key !== null);
    const ordered = [...named].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    // 🔒 Last, and outside the cap: the group of everything the dimension cannot place is not one
    // shelf among many, and dropping it off the end of a capped list would take those documents off
    // the screen rather than off a shelf (docs/11 §11.3).
    const unplaced = groups.filter((group) => group.key === null);
    return { items: [...ordered.slice(0, MAX_DOCUMENT_GROUPS), ...unplaced] };
  }
}

export class UpdateDocumentMeta {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly documentTypes: DocumentTypeRepository,
    private readonly events: DocumentEventRepository,
    private readonly people: PersonRepository,
    private readonly subjects: SubjectRepository,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    input: UpdateDocumentRequest,
  ): Promise<DocumentDetailDto> {
    // A document is a library document by holding a library file, so the rule asks the derived
    // origin rather than a column (docs/03 §3.4).
    if (!canEditDocumentMeta(viewer, detail.document, originOfDetail(detail))) {
      throw new ForbiddenError('You may not edit this document');
    }

    const update: UpdateDocumentMetaInput = {};
    if (input.title !== undefined) {
      update.title = input.title;
      // 🔒 A title somebody typed is theirs: the analysis records what it would have called the
      // document but never renames it again (docs/03 §3.3.10).
      update.titleSource = 'MANUAL';
    }
    // Corrections a person makes by hand. The detector is a guess — it cannot tell Serbian from
    // Croatian in Latin script, and it knows nothing about where a document came from — so being
    // able to fix it is part of the feature, not an afterthought (docs/03 §3.3.10).
    if (input.description !== undefined) update.description = input.description;
    if (input.languages !== undefined) update.languages = input.languages;
    if (input.country !== undefined) update.country = input.country;
    if (input.city !== undefined) update.city = input.city;
    if (input.documentDate !== undefined) update.documentDate = input.documentDate;
    // The shape of a page is decided while the page is being made, so this is the one field here
    // that is not a correction to a record but an instruction the next build will read — stored here
    // and acted on there (docs/05 §5.5 step 1).
    if (input.pageFormat !== undefined) update.pageFormat = input.pageFormat;

    if (input.typeId !== undefined) {
      if (input.typeId === null) {
        // Clearing a documentType is a decision too: it must not read as "never classified", or the
        // next pipeline run would put the old one straight back (docs/03 §3.3.10).
        update.typeId = null;
        update.typeSource = 'NONE';
      } else {
        const documentTypes = await this.documentTypes.listActive();
        const chosen = documentTypes.find((documentType) => documentType.id === input.typeId);
        if (chosen === undefined) {
          throw new NotFoundError('DOCUMENT_TYPE_NOT_FOUND', 'DocumentType not found');
        }
        update.typeId = chosen.id;
        // 🔒 A person's choice is MANUAL, and the classifier never overwrites it (docs/05 §5.5).
        update.typeSource = 'MANUAL';
      }
    }

    // Putting a field back to what the pipeline read. Applied after the explicit values so that a
    // reset always wins: a form can send both, and "put it back" is the later instruction.
    if (input.reset !== undefined) {
      const auto = detail.document.auto;
      for (const field of input.reset) {
        // Only where the analysis actually read a title: "put it back" with nothing to put back
        // would blank the name of the document, and a nameless card is worse than a file name.
        if (field === 'title' && auto.title !== undefined && auto.title !== '') {
          update.title = auto.title;
          // 🔒 Back to AUTO for the same reason the document type is: the document stops claiming a
          // person chose this, and the next run may name it again (docs/03 §3.3.10).
          update.titleSource = 'AUTO';
        }
        if (field === 'description') update.description = auto.description ?? null;
        if (field === 'languages') update.languages = auto.languages ?? [];
        if (field === 'country') update.country = auto.country ?? null;
        if (field === 'city') update.city = auto.city ?? null;
        if (field === 'documentDate') update.documentDate = auto.date ?? null;
        if (field === 'documentType') {
          const documentTypes = await this.documentTypes.listActive();
          const read = documentTypes.find((documentType) => documentType.slug === auto.typeSlug);
          update.typeId = read?.id ?? null;
          // 🔒 Back to AUTO, not MANUAL: the point of a reset is that the document stops claiming a
          // person chose this, so the next run may classify it again (docs/03 §3.3.10).
          update.typeSource = read === undefined ? 'NONE' : 'AUTO';
        }
      }
    }

    // People are a set, not a field on the row: sent whole, replaced whole (docs/03 §3.3.19).
    //
    // 🔒 And checked before they are written. A deleted name stays on the documents that already
    // name it and no new document may take it — which is what 03 §3.3.19 says, and which nothing
    // enforced: the ids went straight to the link table, so a name the catalogue had let go could be
    // put back on any document by anyone who still had its id.
    if (input.peopleIds !== undefined) {
      await assertAllNameable(
        input.peopleIds,
        await this.people.findByIds(input.peopleIds),
        'PERSON_NOT_FOUND',
      );
      await this.people.setForDocument(detail.document.id, input.peopleIds);
    }
    if (input.subjectIds !== undefined) {
      await assertAllNameable(
        input.subjectIds,
        await this.subjects.findByIds(input.subjectIds),
        'SUBJECT_NOT_FOUND',
      );
      await this.subjects.setForDocument(detail.document.id, input.subjectIds);
    }

    const updated = await this.documents.updateMeta(detail.document.id, update);

    // 🔒 A new format does mean a new canonical, and a new preview and new text with it — and it is
    // still not this request's business to start them. Editing metadata must not remake forty pages,
    // recognise their text afresh and replace every artifact derived from them because a select
    // changed: the reader asked for a field to say A4. The instruction waits in the column for the
    // next build, and the asking is `POST /api/documents/:id/reprocess` — which is why the form warns
    // that the pages keep their shape until then (docs/07 §7.3, docs/11 §11.5).
    //
    // What changed, and who changed it. The values are recorded from before and after rather than
    // from the request, so a reset reads as the value it restored (docs/03 §3.3.18).
    const changes = describeChanges(detail.document, updated);
    if (Object.keys(changes).length > 0) {
      await this.events.record({
        documentId: detail.document.id,
        type: 'META_CHANGED',
        actorId: viewer.id,
        payload: { changes },
      });
    }
    const documentType =
      update.typeId === undefined
        ? detail.documentType
        : ((await this.documentTypes.listActive()).find(
            (candidate) => candidate.id === updated.typeId,
          ) ?? null);

    return toDetailDto({
      ...detail,
      document: updated,
      documentType:
        documentType === null
          ? null
          : { id: documentType.id, slug: documentType.slug, name: documentType.name },
    });
  }
}

// DELETE /api/documents/:id (admin): soft delete, after which every route stops finding it.
export class DeleteDocument {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly clock: Clock,
  ) {}

  async execute(documentId: string): Promise<{ ok: true }> {
    const document = await this.documents.findById(documentId);
    if (document === null || document.deletedAt !== null) {
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }
    await this.documents.softDelete(documentId, this.clock.now());
    return { ok: true };
  }
}

// A document is a list of files now, and the list DTO says how many and what they weigh together
// rather than describing the one file it used to be (docs/07 §7.3).
export function toListDto(item: DocumentListItem): DocumentListDto {
  const { document } = item;
  return {
    id: document.id,
    title: document.title,
    fileCount: item.fileCount,
    primaryExt: item.primaryExt,
    sizeBytes: item.sizeBytes.toString(),
    pageCount: document.pageCount,
    documentType: item.documentType,
    availability: item.availability,
    processing: isProcessing(document.steps),
    origin: item.origin,
    hasPreview: document.steps.preview === 'DONE',
    createdAt: document.createdAt.toISOString(),
    // What a card may show besides its title (docs/11 §11.3). Sent whatever the caller draws:
    // which of them appear is a choice made in the reader's URL, not in the request.
    documentDate: document.documentDate,
    people: item.people,
    subjects: item.subjects,
    country: document.country,
    city: document.city,
    languages: document.languages,
  };
}

// One file of a document, in page order (docs/07 §7.3). `refs` are already filtered to the libraries
// the caller may see, so a file with three homes may show one — and `storageKey` answers the same
// question for the file that has no volume at all, so a location is answered for every file rather
// than only for the ones lying on one (docs/09 §9.2).
export function toFileDto(file: DocumentFileView): DocumentFileDto {
  return {
    id: file.id,
    position: file.position,
    name: file.name,
    mimeType: file.mimeType,
    ext: file.ext,
    sizeBytes: file.sizeBytes.toString(),
    origin: file.origin,
    available: file.available,
    isImage: isImageFile(file),
    crop: file.crop,
    cropSource: file.cropSource,
    refs: file.refs,
    // A LIBRARY file has no object at all — its bytes stay on the volume (docs/09 §9.2) — so it has
    // no key rather than a derived one. A MANAGED file's key is what the row recorded, falling back
    // to the layout for a row written before the key was stored.
    storageKey: file.origin === 'MANAGED' ? originalKeyOf(file) : null,
  };
}

// What a list row says about a document, worked out from the files it holds: how many there are,
// what they weigh, whether any of them lies on a volume and whether they can be read right now
// (docs/03 §3.3.10). None of it is stored, so none of it can drift from the composition.
export function listItemOf(detail: DocumentDetail): DocumentListItem {
  const { files } = detail;
  return {
    document: detail.document,
    documentType: detail.documentType,
    fileCount: files.length,
    primaryExt: files[0]?.ext ?? '',
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0n),
    origin: originOf(files.map((file) => file.origin)),
    availability: availabilityOf(files.map((file) => file.available)),
    // The names without what only the viewer needs: whether the catalogue still holds one is the
    // detail's own answer, and it is kept below (docs/11 §11.5).
    people: detail.people.map(({ id, name }) => ({ id, name })),
    subjects: detail.subjects.map(({ id, name }) => ({ id, name })),
  };
}

// A document is a library document by holding a library file, and it is asked of the files rather
// than of a column (docs/03 §3.3.10). The access rule needs this and nothing else about them.
export function originOfDetail(detail: DocumentDetail): FileOrigin {
  return originOf(detail.files.map((file) => file.origin));
}

export function toDetailDto(detail: DocumentDetail): DocumentDetailDto {
  const { document } = detail;
  return {
    ...toListDto(listItemOf(detail)),
    ocrUsed: document.ocrUsed,
    description: document.description,
    pageFormat: document.pageFormat,
    titleSource: document.titleSource,
    typeSource: document.typeSource,
    steps: document.steps,
    skipReasons: document.skipReasons,
    auto: document.auto,
    // The list DTO carries these names too; here they say in addition whether the catalogue still
    // holds each one (docs/03 §3.3.19–3.3.20).
    people: detail.people,
    subjects: detail.subjects,
    processingError: document.processingError,
    failedStep: document.failedStep,
    files: detail.files.map(toFileDto),
    createdBy: detail.createdBy,
  };
}

// Before and after, for the fields a person may edit. Only what actually moved: a log full of
// "title: Ticket → Ticket" is a log nobody reads (docs/03 §3.3.18).
function describeChanges(
  before: Document,
  after: Document,
): Record<string, { from?: string | null | undefined; to?: string | null | undefined }> {
  const changes: Record<string, { from?: string | null; to?: string | null }> = {};
  if (before.title !== after.title) changes.title = { from: before.title, to: after.title };
  if (before.typeId !== after.typeId) {
    changes.documentType = { from: before.typeId, to: after.typeId };
  }
  if (before.languages.join('|') !== after.languages.join('|')) {
    changes.languages = { from: before.languages.join(', '), to: after.languages.join(', ') };
  }
  if (before.country !== after.country)
    changes.country = { from: before.country, to: after.country };
  if (before.city !== after.city) changes.city = { from: before.city, to: after.city };
  if (before.documentDate !== after.documentDate) {
    changes.documentDate = { from: before.documentDate, to: after.documentDate };
  }
  // The one field here that rebuilds the document rather than correcting a record, and so the one
  // most worth being able to trace afterwards: a canonical that changed shape and a journal that
  // says only "queued" leaves nobody able to say why (docs/03 §3.3.18).
  if (before.pageFormat !== after.pageFormat) {
    changes.pageFormat = { from: before.pageFormat, to: after.pageFormat };
  }
  return changes;
}

// Every id asked for has to come back from a lookup that returns only what may still be named. An id
// that does not is either gone or invented, and both answer the same way: a caller holding the id of
// something deleted has learned nothing about whether it ever existed.
function assertAllNameable(
  asked: readonly string[],
  found: ReadonlyArray<{ id: string }>,
  code: 'PERSON_NOT_FOUND' | 'SUBJECT_NOT_FOUND',
): Promise<void> {
  const living = new Set(found.map((row) => row.id));
  const missing = asked.find((id) => !living.has(id));
  if (missing !== undefined) {
    return Promise.reject(new NotFoundError(code, 'That name is no longer in the catalogue'));
  }
  return Promise.resolve();
}
