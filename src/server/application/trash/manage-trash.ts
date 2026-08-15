import type {
  EmptyTrashResponse,
  ListTrashQuery,
  ListTrashResponse,
  RestoreTrashResponse,
  TrashItemDto,
} from '../../../shared/contracts/trash';
import { isImageFile, purgeAfterOf, type File } from '../../domain/entities/file';
import { ConflictError, NotFoundError } from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { FileRepository, TrashedFile } from '../../domain/repositories/file.repository';
import { titleOf } from '../documents/compose-document';
import type { DocumentFileBytes } from '../documents/document-file-bytes';
import type { Download } from '../documents/download-document';
import type { FileStorage } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys, originalDelivery, originalKeyOf } from '../storage/artifact-keys';

// The trash (docs/05 §5.7a, docs/07 §7.3, docs/11 §11.13b): every file that has left a document and
// has not been destroyed yet. An admin's, because everything here either destroys bytes or makes a
// document.

// GET /api/admin/trash: the page, and what the whole of it costs.
export class ListTrash {
  constructor(
    private readonly files: FileRepository,
    private readonly retentionDays: number,
  ) {}

  async execute(query: ListTrashQuery): Promise<ListTrashResponse> {
    // The cursor is the `trashedAt` of the last row (docs/07 §7.1); a cursor that is not a timestamp
    // is a cursor from somewhere else and reads as the first page rather than as an error nobody can
    // act on.
    const cursor = query.cursor === undefined ? undefined : parseInstant(query.cursor);
    const page = await this.files.listTrashed({ limit: query.limit, cursor });
    const items = page.items.map((file) => toTrashItem(file, this.retentionDays));

    return {
      items,
      nextCursor:
        page.items.length < query.limit
          ? null
          : (last(page.items)?.trashedAt?.toISOString() ?? null),
      total: { items: page.totalItems, bytes: page.totalBytes.toString() },
    };
  }
}

// DELETE /api/admin/trash/:fileId — one item, for good.
export class DeleteTrashItem {
  constructor(
    private readonly files: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly storage: FileStorage,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(fileId: string): Promise<{ ok: true }> {
    const file = await this.files.findById(fileId);
    if (file === null || file.trashedAt === null) {
      throw new NotFoundError('FILE_NOT_FOUND', 'Nothing in the trash by that id');
    }
    await purge([file], this.files, this.fileRefs, this.storage, this.unitOfWork);
    return { ok: true };
  }
}

// DELETE /api/admin/trash — all of it. Not "everything due": the retention window says when a file
// goes at the latest, and this is a person saying "now" (docs/05 §5.7a).
export class EmptyTrash {
  constructor(
    private readonly files: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly storage: FileStorage,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(): Promise<EmptyTrashResponse> {
    const held = await this.files.listAllTrashed();
    await purge(held, this.files, this.fileRefs, this.storage, this.unitOfWork);
    return { deleted: held.length };
  }
}

// GET /api/admin/trash/:fileId/content — the bytes of one item (docs/07 §7.3).
//
// It exists because the document route cannot serve these: that one starts from a document, and a
// file in the trash has none. Getting a scan back out of the trash is often the whole errand, and it
// should not require restoring it into a document first.
export class DownloadTrashItem {
  constructor(
    private readonly files: FileRepository,
    private readonly refs: FileRefRepository,
    private readonly bytes: DocumentFileBytes,
    private readonly storage: FileStorage,
    private readonly signedUrlTtlSec: number,
  ) {}

  async execute(fileId: string): Promise<Download> {
    const file = await this.files.findById(fileId);
    if (file === null || file.trashedAt === null) {
      throw new NotFoundError('FILE_NOT_FOUND', 'Nothing in the trash by that id');
    }

    // The same terms as any other original: something to save, under the name it arrived with
    // (docs/09 §9.2).
    const delivery = originalDelivery(file);
    if (file.origin === 'MANAGED') {
      return {
        kind: 'redirect',
        delivery,
        url: await this.storage.getSignedUrl(originalKeyOf(file), this.signedUrlTtlSec, delivery),
      };
    }

    // A trashed library file keeps its paths — excluded ones included, since the bytes are still
    // there and this is the one place that says so out loud (docs/05 §5.7a).
    const refs = await this.refs.listForFile(file.id, file.contentHash);
    return {
      kind: 'stream',
      body: await this.bytes.open({ ...file, refs }),
      delivery,
      contentLength: file.sizeBytes,
    };
  }
}

// POST /api/admin/trash/:fileId/restore — the file becomes a document of its own.
//
// A **new** one, never the document it came from: that document has moved on or does not exist, and
// putting a page back into a page order that changed underneath it would be a guess (docs/05 §5.7a).
// This is the same act as a split, and it is deliberately identical to it.
export class RestoreTrashItem {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly files: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly events: DocumentEventRepository,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async execute(fileId: string, actorId: string): Promise<RestoreTrashResponse> {
    const file = await this.files.findById(fileId);
    if (file === null || file.trashedAt === null) {
      throw new NotFoundError('FILE_NOT_FOUND', 'Nothing in the trash by that id');
    }

    return this.unitOfWork.run(async (tx) => {
      // Bytes deduplicate to one file (ADR-021), so the same content may have been uploaded again
      // while this sat here — and then it has a home and there is nothing to restore.
      const home = await this.files.findDocumentIdForFile(file.id, tx);
      if (home !== null) {
        throw new ConflictError(
          'FILE_ALREADY_IN_DOCUMENT',
          'These bytes are already a file of a document',
        );
      }

      const restored = await this.files.untrash(file.id, tx);
      // Its paths on a volume become live again: the bytes are there and their hash is known, which
      // is what `EXCLUDED` was holding back (docs/03 §3.3.9).
      await this.fileRefs.markRestored(restored.id, restored.contentHash, tx);

      const document = await this.documents.create(
        { title: titleOf(restored.name), createdById: actorId },
        tx,
      );
      await this.files.attach(document.id, restored.id, tx);
      await this.queue.enqueueAfterTx(tx, 'document-process', { documentId: document.id });

      await this.events.record(
        {
          documentId: document.id,
          type: 'CREATED',
          actorId,
          payload: { source: 'RESTORE', path: restored.name },
        },
        tx,
      );
      await this.events.record(
        {
          documentId: document.id,
          type: 'FILE_ATTACHED',
          actorId,
          payload: { source: 'RESTORE', path: restored.name },
        },
        tx,
      );
      await this.events.record({ documentId: document.id, type: 'QUEUED', actorId }, tx);

      return { documentId: document.id };
    });
  }
}

// Deleting for good, wherever it is asked for: the rows in one transaction, the objects after it
// commits — the same order and for the same reason as deleting a document (docs/09 §9.2).
//
// 🔒 A LIBRARY file's bytes are not touched and its refs stay `EXCLUDED`: the volume is read-only,
// and the exclusion is what keeps the next scan from ingesting the same bytes into a new document
// (docs/03 §3.3.9). Deleting such an item removes what Legere knows about the file and no more.
export async function purge(
  held: readonly File[],
  files: FileRepository,
  fileRefs: FileRefRepository,
  storage: FileStorage,
  unitOfWork: UnitOfWork,
): Promise<void> {
  if (held.length === 0) return;
  const ids = held.map((file) => file.id);

  await unitOfWork.run(async (tx) => {
    await fileRefs.markExcluded(ids, tx);
    await files.hardDelete(ids, tx);
  });

  for (const file of held) {
    // Everything under the file's own prefix, not only its original: the page thumbnails rendered
    // off it exist for a file that is about to stop existing, and a page of nothing is not a picture
    // anybody can ask for again (docs/09 §9.2). A LIBRARY file has no original here and may still
    // have those, which is why the prefix is listed rather than one key being guessed — and its
    // bytes on the volume are, as ever, untouched.
    try {
      const objects = await storage.list(artifactKeys.filePrefix(file.id));
      for (const object of objects) await storage.delete(object.key);
    } catch {
      // The row is gone, so the objects are orphans and the hourly sweep collects them
      // (docs/09 §9.2).
      continue;
    }
  }
}

export function toTrashItem(file: TrashedFile, retentionDays: number): TrashItemDto {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    ext: file.ext,
    sizeBytes: file.sizeBytes.toString(),
    origin: file.origin,
    available: file.available,
    isImage: isImageFile(file),
    // 🔒 Both of these are narrowed from nullable columns, and both are non-null by construction:
    // everything on this list is in the trash. A row that somehow is not would be a bug, and it is
    // shown as what it least misrepresents rather than crashing the screen that would reveal it.
    reason: file.trashedReason ?? 'DOCUMENT_DELETED',
    trashedAt: (file.trashedAt ?? file.updatedAt).toISOString(),
    trashedFrom: file.trashedFrom,
    purgeAfter: purgeAfterOf(file, retentionDays)?.toISOString() ?? null,
    refs: file.refs,
    storageKey: file.origin === 'MANAGED' ? originalKeyOf(file) : null,
  };
}

function parseInstant(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function last<T>(items: readonly T[]): T | undefined {
  return items[items.length - 1];
}
