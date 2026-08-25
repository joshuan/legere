import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type DocumentPage as PrismaDocumentPage,
  type File as PrismaFile,
} from '@prisma/client';
import {
  cropSchema,
  rotationSchema,
  type Crop,
  type Rotation,
} from '../../../shared/contracts/documents';
import type { TrashReason } from '../../../shared/contracts/enums';
import { artifactKeys } from '../../application/storage/artifact-keys';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { DocumentPage, PageEntry } from '../../domain/entities/document-page';
import type { File } from '../../domain/entities/file';
import { ConflictError } from '../../domain/errors/domain-error';
import {
  FileRepository,
  type CreateFileInput,
  type DocumentFile,
  type DocumentPageWithFile,
  type FileRefView,
  type TrashedFile,
} from '../../domain/repositories/file.repository';
import { clientOf, isPrismaTx } from './prisma-client';
import type { PrismaTx } from './prisma-unit-of-work';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaFile): File {
  return {
    id: row.id,
    contentHash: row.contentHash,
    origin: row.origin,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    ext: row.ext,
    sizeBytes: row.sizeBytes,
    name: row.name,
    pageCount: row.pageCount,
    trashedAt: row.trashedAt,
    trashedReason: row.trashedReason,
    trashedFrom: row.trashedFrom,
    replacedById: row.replacedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

// The column is jsonb, so what comes back is `unknown` as far as types go: parse it rather than
// trusting it. A crop that cannot be read is no crop — the file is still a file, and the canonical
// is rebuilt from the whole image instead of failing.
function toCrop(value: unknown): Crop | null {
  const parsed = cropSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// A JSON column set to `null` must become SQL NULL rather than the JSON literal `null`, which is a
// different value and would read back as "a crop nobody can parse".
function toCropColumn(crop: Crop | null): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return crop === null ? Prisma.DbNull : { points: crop.points };
}

// And the turn, on the same terms: jsonb parsed rather than trusted, because a turn nobody can read
// is no turn and the page stands the way it arrived (docs/05 §5.5 step 1).
function toRotation(value: unknown): Rotation | null {
  const parsed = rotationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toRotationColumn(
  rotation: Rotation | null,
): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  return rotation === null
    ? Prisma.DbNull
    : { quarterTurns: rotation.quarterTurns, mirrored: rotation.mirrored };
}

// One entry of a document's list (docs/03 §3.3.17). The two json columns are parsed rather than
// trusted, exactly as they were while they sat on the file.
function toPage(row: PrismaDocumentPage): DocumentPage {
  return {
    id: row.id,
    documentId: row.documentId,
    position: row.position,
    fileId: row.fileId,
    pageIndex: row.pageIndex,
    turn: toRotation(row.turn),
    crop: toCrop(row.crop),
    cropSource: row.cropSource,
  };
}

// The columns a unique violation names, so a P2002 can be attributed to the index that raised it.
// Empty rather than null when Prisma reports nothing: the violation happened, we just cannot say
// which constraint it was.
function uniqueViolationColumns(error: unknown): string[] | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = error.meta?.['target'];
  if (typeof target === 'string') return [target];
  if (!Array.isArray(target)) return [];
  return target.filter((column): column is string => typeof column === 'string');
}

@Injectable()
export class PrismaFileRepository implements FileRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<File | null> {
    const row = await clientOf(this.prisma, tx).file.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async findActiveByContentHash(contentHash: string, tx?: TransactionHandle): Promise<File | null> {
    const row = await clientOf(this.prisma, tx).file.findFirst({
      where: { contentHash, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async findOrCreateByContentHash(
    input: CreateFileInput,
    tx?: TransactionHandle,
  ): Promise<{ file: File; created: boolean }> {
    const existing = await this.findActiveByContentHash(input.contentHash, tx);
    if (existing !== null) return { file: existing, created: false };

    try {
      const row = await clientOf(this.prisma, tx).file.create({
        data: {
          contentHash: input.contentHash,
          origin: input.origin,
          storageKey: input.storageKey,
          mimeType: input.mimeType,
          ext: input.ext,
          sizeBytes: input.sizeBytes,
          name: input.name,
        },
      });

      // A managed file's key is `files/{id}/original.{ext}`, and the id only exists once the row
      // does — so it is written back here rather than guessed by the caller. The column is what
      // docs/09 §9.2 promises will keep resolving after the layout changes, so it must not stay
      // empty for the files written under the current one.
      if (row.origin === 'MANAGED' && row.storageKey === null) {
        const storageKey = artifactKeys.fileOriginal(row.id, row.ext);
        const withKey = await clientOf(this.prisma, tx).file.update({
          where: { id: row.id },
          data: { storageKey },
        });
        return { file: toDomain(withKey), created: true };
      }

      return { file: toDomain(row), created: true };
    } catch (error) {
      // files_content_hash_active_uq (docs/04 §4.3): another ingest inserted the same bytes between
      // the read above and this write. Whoever lost simply uses the winner, so identical content
      // still yields exactly one file (ADR-009 one level down, ADR-021).
      if (uniqueViolationColumns(error) !== null) {
        const winner = await this.findActiveByContentHash(input.contentHash, tx);
        if (winner !== null) return { file: winner, created: false };
      }
      throw error;
    }
  }

  // `updateMany` rather than `update`: the build writes this while the file may be going away under
  // it — a document deleted mid-rebuild — and a count nobody can write is not worth failing a
  // canonical over (docs/05 §5.5 step 1).
  async recordPageCount(id: string, pageCount: number, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).file.updateMany({ where: { id }, data: { pageCount } });
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).file.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }

  async hardDelete(ids: readonly string[], tx?: TransactionHandle): Promise<void> {
    if (ids.length === 0) return;
    await clientOf(this.prisma, tx).file.deleteMany({ where: { id: { in: [...ids] } } });
  }

  // No `deletedAt` filter, for the same reason the document's own version has none: a row that
  // exists at all owns its object, and only a row that is gone makes one an orphan (docs/09 §9.2).
  async filterExistingIds(ids: string[], tx?: TransactionHandle): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).file.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  // --- the trash (docs/05 §5.7a) --------------------------------------------------------------

  async trash(
    input: {
      fileIds: readonly string[];
      reason: TrashReason;
      trashedFrom: string | null;
      replacedById?: string | undefined;
      at: Date;
    },
    tx?: TransactionHandle,
  ): Promise<void> {
    if (input.fileIds.length === 0) return;
    const client = clientOf(this.prisma, tx);
    const ids = [...input.fileIds];

    // The versions this page already had point at whatever replaced it; when it is replaced again
    // they follow, so every copy of a page points at the file in the document *now* and listing them
    // stays one query (docs/03 §3.3.16).
    if (input.replacedById !== undefined) {
      await client.file.updateMany({
        where: { replacedById: { in: ids } },
        data: { replacedById: input.replacedById },
      });
    }

    await client.file.updateMany({
      where: { id: { in: ids } },
      data: {
        trashedAt: input.at,
        trashedReason: input.reason,
        trashedFrom: input.trashedFrom,
        replacedById: input.replacedById ?? null,
      },
    });
  }

  async untrash(id: string, tx?: TransactionHandle): Promise<File> {
    const row = await clientOf(this.prisma, tx).file.update({
      where: { id },
      data: { trashedAt: null, trashedReason: null, trashedFrom: null, replacedById: null },
    });
    return toDomain(row);
  }

  async listVersionsFor(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, File[]>> {
    const byFile = new Map<string, File[]>(fileIds.map((id) => [id, []]));
    if (fileIds.length === 0) return byFile;

    const rows = await clientOf(this.prisma, tx).file.findMany({
      where: { replacedById: { in: [...fileIds] } },
      // Newest first: the copy replaced most recently is the one somebody is comparing against.
      orderBy: { trashedAt: 'desc' },
    });
    for (const row of rows) {
      if (row.replacedById === null) continue;
      byFile.get(row.replacedById)?.push(toDomain(row));
    }
    return byFile;
  }

  async listTrashed(
    query: { limit: number; cursor?: Date | undefined },
    tx?: TransactionHandle,
  ): Promise<{ items: TrashedFile[]; totalItems: number; totalBytes: bigint }> {
    const client = clientOf(this.prisma, tx);
    const inTheTrash = { trashedAt: { not: null } };

    const rows = await client.file.findMany({
      where:
        query.cursor === undefined
          ? inTheTrash
          : { AND: [inTheTrash, { trashedAt: { lt: query.cursor } }] },
      orderBy: { trashedAt: 'desc' },
      take: query.limit,
    });

    // 🔒 Where the bytes are — by **content hash**, not through the `refs` relation. Excluding a ref
    // is what clears its `file_id` (docs/03 §3.3.9), so a file whose document was deleted has no
    // relation left to follow and would list as having no whereabouts at all: exactly the file for
    // which naming the path matters most, since only a person can clear it (docs/11 §11.13b). No
    // visibility filter — the trash is an admin's, and an admin sees every library anyway.
    const hashes = rows.map((row) => row.contentHash);
    const refRows =
      hashes.length === 0
        ? []
        : await client.fileRef.findMany({
            where: { contentHash: { in: hashes } },
            include: { library: { select: { name: true } } },
            orderBy: { path: 'asc' },
          });

    const refsByHash = new Map<string, FileRefView[]>();
    for (const ref of refRows) {
      if (ref.contentHash === null) continue;
      const view = {
        libraryId: ref.libraryId,
        libraryName: ref.library.name,
        path: ref.path,
        status: ref.status,
      };
      const found = refsByHash.get(ref.contentHash);
      if (found === undefined) refsByHash.set(ref.contentHash, [view]);
      else found.push(view);
    }

    // The whole trash, not the page: "what is this costing me" is the question the screen answers,
    // and one aggregate is cheaper than paging to the end to find out (docs/07 §7.3).
    const totals = await client.file.aggregate({
      where: inTheTrash,
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });

    return {
      items: rows.map((row) => {
        const refs = refsByHash.get(row.contentHash) ?? [];
        return {
          ...toDomain(row),
          refs,
          // A MANAGED file's bytes are ours and do not go missing behind our back; a LIBRARY file's
          // are readable while a path still holds them — `EXCLUDED` among them, since that says
          // Legere will not *ingest* the file again and nothing about the bytes (docs/05 §5.7a).
          available:
            row.origin === 'MANAGED' ||
            refs.some((ref) => ref.status === 'HASHED' || ref.status === 'EXCLUDED'),
        };
      }),
      totalItems: totals._count._all,
      totalBytes: totals._sum.sizeBytes ?? 0n,
    };
  }

  async listAllTrashed(tx?: TransactionHandle): Promise<File[]> {
    const rows = await clientOf(this.prisma, tx).file.findMany({
      where: { trashedAt: { not: null } },
      orderBy: { trashedAt: 'desc' },
    });
    return rows.map(toDomain);
  }

  // 🔒 `origin: MANAGED` is the load-bearing half: a LIBRARY file's bytes are on a read-only volume,
  // so no window closes on them however long they sit here (docs/05 §5.7a).
  async listPurgeable(before: Date, limit: number, tx?: TransactionHandle): Promise<File[]> {
    const rows = await clientOf(this.prisma, tx).file.findMany({
      where: { origin: 'MANAGED', trashedAt: { not: null, lte: before } },
      orderBy: { trashedAt: 'asc' },
      take: limit,
    });
    return rows.map(toDomain);
  }

  // --- the composition of a document -------------------------------------------------------

  async listPagesForDocument(
    documentId: string,
    tx?: TransactionHandle,
  ): Promise<DocumentPageWithFile[]> {
    const rows = await clientOf(this.prisma, tx).documentPage.findMany({
      where: { documentId },
      include: { file: true },
      orderBy: { position: 'asc' },
    });
    return rows.map((row) => ({ ...toPage(row), file: toDomain(row.file) }));
  }

  // Wholesale, because `(document_id, position)` is unique: shifting rows one at a time collides
  // with itself halfway through (docs/03 §3.3.17). Delete-then-insert in one transaction is the only
  // rewrite that cannot deadlock against its own intermediate state, and an entry that was already
  // there is written back under its own id, so nothing addressing it is invalidated by a rebuild.
  async replacePages(
    documentId: string,
    pages: readonly PageEntry[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const rewrite = async (client: PrismaTx): Promise<void> => {
      await client.documentPage.deleteMany({ where: { documentId } });
      if (pages.length === 0) return;
      await client.documentPage.createMany({
        data: pages.map((page, position) => ({
          ...(page.id === undefined ? {} : { id: page.id }),
          documentId,
          position,
          fileId: page.fileId,
          pageIndex: page.pageIndex,
          turn: toRotationColumn(page.turn),
          crop: toCropColumn(page.crop),
          cropSource: page.cropSource,
        })),
      });
    };

    if (tx !== undefined && isPrismaTx(tx)) {
      await rewrite(tx);
      return;
    }
    await this.prisma.$transaction(rewrite);
  }

  async listForDocument(documentId: string, tx?: TransactionHandle): Promise<DocumentFile[]> {
    return filesOf(await this.listPagesForDocument(documentId, tx));
  }

  // One query for a whole page: the list needs a count, an extension and a weight per row, and a
  // query per document would be a query per row (docs/03 §3.3.10).
  async listForDocuments(
    documentIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, DocumentFile[]>> {
    const byDocument = new Map<string, DocumentFile[]>(documentIds.map((id) => [id, []]));
    if (documentIds.length === 0) return byDocument;

    const rows = await clientOf(this.prisma, tx).documentPage.findMany({
      where: { documentId: { in: [...documentIds] } },
      include: { file: true },
      orderBy: [{ documentId: 'asc' }, { position: 'asc' }],
    });

    const pagesByDocument = new Map<string, DocumentPageWithFile[]>();
    for (const row of rows) {
      const page = { ...toPage(row), file: toDomain(row.file) };
      const held = pagesByDocument.get(row.documentId);
      if (held === undefined) pagesByDocument.set(row.documentId, [page]);
      else held.push(page);
    }
    for (const [documentId, pages] of pagesByDocument) {
      if (!byDocument.has(documentId)) continue;
      byDocument.set(documentId, filesOf(pages));
    }
    return byDocument;
  }

  // A soft-deleted document keeps its pages rather than releasing them (docs/03 §3.3.10), so this
  // answers with a document that reads the file, deleted or not — which is what stops the next scan
  // from ingesting a file whose document an admin removed on purpose. Since ADR-025 there may be
  // several; every caller is asking whether anything reads it at all.
  async findDocumentIdForFile(fileId: string, tx?: TransactionHandle): Promise<string | null> {
    const row = await clientOf(this.prisma, tx).documentPage.findFirst({
      where: { fileId },
      select: { documentId: true },
    });
    return row === null ? null : row.documentId;
  }

  async filterFilesWithoutLivePages(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<string[]> {
    if (fileIds.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).documentPage.findMany({
      where: { fileId: { in: [...fileIds] } },
      select: { fileId: true },
      distinct: ['fileId'],
    });
    const stillRead = new Set(rows.map((row) => row.fileId));
    return fileIds.filter((fileId) => !stillRead.has(fileId));
  }

  async attach(documentId: string, fileId: string, tx?: TransactionHandle): Promise<void> {
    const client = clientOf(this.prisma, tx);

    // Asked before inserting rather than only caught afterwards: a failed statement poisons the
    // surrounding transaction, and the caller of `attach` is usually inside one. The rule is the
    // product's and no longer the schema's — a file may be read by pages of two documents
    // (ADR-025) — so it is asked here rather than left to a unique index that no longer exists.
    const home = await client.documentPage.findFirst({ where: { fileId } });
    if (home !== null) throw fileAlreadyInDocument();

    const file = await client.file.findUnique({
      where: { id: fileId },
      select: { pageCount: true },
    });
    const last = await client.documentPage.aggregate({
      where: { documentId },
      _max: { position: true },
    });
    const from = (last._max.position ?? -1) + 1;

    // Its own pages where a build has counted them, and one entry standing for the file whole where
    // none has — the transitional state of ADR-025, which the next build ends.
    const pageCount = file?.pageCount ?? null;
    const indices: (number | null)[] =
      pageCount === null || pageCount < 1
        ? [null]
        : Array.from({ length: pageCount }, (unused, index) => index);

    await client.documentPage.createMany({
      data: indices.map((pageIndex, offset) => ({
        documentId,
        position: from + offset,
        fileId,
        pageIndex,
      })),
    });
  }

  // Every page of that file leaves this document; another document reading the same file is not
  // touched. What is left closes up behind it, because positions are contiguous (docs/03 §3.3.17).
  async detach(documentId: string, fileId: string, tx?: TransactionHandle): Promise<void> {
    const client = clientOf(this.prisma, tx);
    const rows = await client.documentPage.findMany({
      where: { documentId },
      orderBy: { position: 'asc' },
      include: { file: true },
    });
    const kept = rows
      .filter((row) => row.fileId !== fileId)
      .map((row) => ({ ...toPage(row), file: toDomain(row.file) }));
    if (kept.length === rows.length) return;
    await this.replacePages(documentId, kept, tx);
  }

  // Rewrites positions wholesale from the given order of files, each file's pages moving as a block
  // and keeping the order this document reads them in.
  async reorder(
    documentId: string,
    fileIdsInOrder: readonly string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const rewrite = async (client: PrismaTx): Promise<void> => {
      const pages = await this.listPagesForDocument(documentId, client);
      const ordered = fileIdsInOrder.flatMap((fileId) =>
        pages.filter((page) => page.fileId === fileId),
      );
      // A file the order does not name keeps its pages rather than losing them: the caller has
      // already refused a partial order, and dropping pages here would be a worse answer than
      // leaving them where they were.
      const named = new Set(fileIdsInOrder);
      const rest = pages.filter((page) => !named.has(page.fileId));
      await this.replacePages(documentId, [...ordered, ...rest], client);
    };

    if (tx !== undefined && isPrismaTx(tx)) {
      await rewrite(tx);
      return;
    }
    await this.prisma.$transaction(rewrite);
  }

  // Availability for a whole page in one query (docs/03 §3.3.10): every file asked about is in the
  // answer, with zero for the ones no volume holds any more.
  async countLiveRefsForFiles(
    fileIds: readonly string[],
    tx?: TransactionHandle,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>(fileIds.map((id) => [id, 0]));
    if (fileIds.length === 0) return counts;

    const rows = await clientOf(this.prisma, tx).fileRef.groupBy({
      by: ['fileId'],
      where: { fileId: { in: [...fileIds] }, status: 'HASHED', library: { deletedAt: null } },
      _count: { _all: true },
    });

    for (const row of rows) {
      if (row.fileId === null) continue;
      counts.set(row.fileId, row._count._all);
    }
    return counts;
  }
}

// The files a list of pages is read from, in the order those pages first name them, each carrying
// the pages it is read as here (docs/03 §3.3.17). This is where "the files of a document" is
// answered now that the rows are pages.
function filesOf(pages: readonly DocumentPageWithFile[]): DocumentFile[] {
  const files: DocumentFile[] = [];
  const byFile = new Map<string, DocumentFile>();
  for (const page of pages) {
    const held = byFile.get(page.fileId);
    if (held === undefined) {
      const file: DocumentFile = { ...page.file, position: files.length, pages: [stripFile(page)] };
      byFile.set(page.fileId, file);
      files.push(file);
      continue;
    }
    held.pages.push(stripFile(page));
  }
  return files;
}

function stripFile(page: DocumentPageWithFile): DocumentPage {
  return {
    id: page.id,
    documentId: page.documentId,
    position: page.position,
    fileId: page.fileId,
    pageIndex: page.pageIndex,
    turn: page.turn,
    crop: page.crop,
    cropSource: page.cropSource,
  };
}

function fileAlreadyInDocument(): ConflictError {
  return new ConflictError(
    'FILE_ALREADY_IN_DOCUMENT',
    'This file already belongs to another document',
  );
}
