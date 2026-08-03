import { Injectable } from '@nestjs/common';
import { Prisma, type Document as PrismaDocument } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { z } from 'zod';
import type { Document, SkipReasons } from '../../domain/entities/document';
import { DOCUMENT_STEPS, type DocumentStep } from '../../../shared/contracts/documents';
import {
  stepSkipReasonSchema,
  stepStatusSchema,
  type DocumentSource,
  type StepStatus,
} from '../../../shared/contracts/enums';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentListItem,
  type DocumentPage,
  type DocumentUpsert,
  type ListDocumentsInput,
  type ProcessingUpdate,
  type SearchFilters,
  type SearchMatch,
  type StepStatusCounters,
  type UpdateDocumentMetaInput,
  type Viewer,
} from '../../domain/repositories/document.repository';
import { decodeCursor, decodeTextCursor, encodeCursor, encodeTextCursor } from './cursor';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaDocument): Document {
  return {
    id: row.id,
    contentHash: row.contentHash,
    source: row.source,
    mimeType: row.mimeType,
    ext: row.ext,
    sizeBytes: row.sizeBytes,
    pageCount: row.pageCount,
    title: row.title,
    markdown: row.markdown,
    steps: {
      canonical: row.canonicalStatus,
      preview: row.previewStatus,
      markdown: row.markdownStatus,
      categorization: row.categorizationStatus,
      vectorization: row.vectorizationStatus,
    },
    processingError: row.processingError,
    skipReasons: toSkipReasons(row.skipReasons),
    failedStep: row.failedStep,
    ocrUsed: row.ocrUsed,
    categoryId: row.categoryId,
    categorySource: row.categorySource,
    createdById: row.createdById,
    scanSetId: row.scanSetId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

// What a list row needs beyond its own columns: the category, and how many of its files are still
// live on a mounted volume (docs/03 §3.3.10). A filtered relation count keeps that to one query for
// the whole page — and, unlike including the refs themselves, it counts every library rather than
// only the ones this viewer can see.
const LIST_INCLUDE = {
  category: { select: { id: true, slug: true, name: true } },
  _count: { select: { fileRefs: { where: { status: 'HASHED', library: { deletedAt: null } } } } },
} as const;

type ListRow = PrismaDocument & {
  category: { id: string; slug: string; name: string } | null;
  _count: { fileRefs: number };
};

function toListItem(row: ListRow): DocumentListItem {
  const document = toDomain(row);
  return {
    document,
    category: row.category,
    // A document whose bytes are in the bucket — merged or uploaded — is always available.
    availability:
      document.source !== 'LIBRARY' || row._count.fileRefs > 0 ? 'AVAILABLE' : 'UNAVAILABLE',
  };
}

// The column is jsonb, so what comes back is `unknown` as far as types go: parse it rather than
// trusting it, and treat anything unrecognised as "no reason recorded".
function toSkipReasons(value: unknown): SkipReasons {
  const parsed = z.record(stepSkipReasonSchema).safeParse(value);
  if (!parsed.success) return {};
  const reasons: SkipReasons = {};
  for (const step of DOCUMENT_STEPS) {
    const reason = parsed.data[step];
    if (reason !== undefined) reasons[step] = reason;
  }
  return reasons;
}

// The two kinds whose bytes we hold ourselves: a scan-set result and an upload. They differ in where
// they came from and in nothing else the access rule cares about (docs/03 §3.4).
// Not `as const`: Prisma's `in` filter takes a mutable array, and a readonly tuple does not fit.
const OWNED_SOURCES: DocumentSource[] = ['DERIVED', 'UPLOAD'];

// The access rule of docs/03 §3.4, expressed once, in SQL, so a page of results never has to be
// filtered afterwards — and no route can forget to apply it.
function readableBy(viewer: Viewer): Prisma.DocumentWhereInput {
  if (viewer.role === 'ADMIN') return {};

  return {
    OR: [
      // A library document is readable through any of its files that sits in a library the viewer
      // can see — including a file that has gone MISSING, which makes the document unavailable but
      // not invisible.
      {
        source: 'LIBRARY',
        fileRefs: { some: { library: { deletedAt: null, ...visibleLibrary(viewer) } } },
      },
      // A document we hold the bytes for — a scan-set result, an upload — belongs to whoever made it,
      // plus anyone it was shared with through a collection (docs/08 §8.5).
      { source: { in: OWNED_SOURCES }, createdById: viewer.id },
      {
        source: { in: OWNED_SOURCES },
        collectionItems: {
          some: {
            collection: {
              deletedAt: null,
              OR: [
                { ownerId: viewer.id },
                {
                  shares: {
                    some: {
                      revokedAt: null,
                      // A share with no grantee is instance-wide (docs/03 §3.3.15).
                      OR: [{ granteeUserId: viewer.id }, { granteeUserId: null }],
                    },
                  },
                },
              ],
            },
          },
        },
      },
    ],
  };
}

function visibleLibrary(viewer: Viewer): Prisma.LibraryWhereInput {
  if (viewer.role === 'ADMIN') return {};
  return { OR: [{ visibility: 'ALL_USERS' }, { access: { some: { userId: viewer.id } } }] };
}

function filters(query: ListDocumentsInput): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = {};

  if (query.libraryId !== undefined) {
    where.fileRefs = { some: { libraryId: query.libraryId, library: { deletedAt: null } } };
  }
  if (query.categoryId !== undefined) where.categoryId = query.categoryId;
  if (query.source !== undefined) where.source = query.source;

  if (query.availability !== undefined) {
    // Availability is derived, so it filters on the same condition it is computed from.
    const live: Prisma.FileRefListRelationFilter = {
      some: { status: 'HASHED', library: { deletedAt: null } },
    };
    where.AND = [
      query.availability === 'AVAILABLE'
        ? { OR: [{ source: { in: OWNED_SOURCES } }, { fileRefs: live }] }
        : { source: 'LIBRARY', NOT: { fileRefs: live } },
    ];
  }

  if (query.processing !== undefined) {
    // "Processing" means any step is still PENDING (docs/03 §3.3.10).
    const pending: Prisma.DocumentWhereInput[] = [
      { canonicalStatus: 'PENDING' },
      { previewStatus: 'PENDING' },
      { markdownStatus: 'PENDING' },
      { categorizationStatus: 'PENDING' },
      { vectorizationStatus: 'PENDING' },
    ];
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : []),
      query.processing ? { OR: pending } : { NOT: { OR: pending } },
    ];
  }

  return where;
}

// The access rule of docs/03 §3.4 again, this time as SQL. Search ranks and limits inside the
// query — a limit of 20 has to mean 20 readable rows — and the query builder cannot express
// ts_rank or the vector operator, so the rule exists in both dialects. They are tested together by
// the same e2e cases.
function readableSql(viewer: Viewer): Prisma.Sql {
  if (viewer.role === 'ADMIN') return Prisma.sql`d.deleted_at IS NULL`;

  return Prisma.sql`
    d.deleted_at IS NULL
    AND (
      (d.source = 'LIBRARY' AND EXISTS (
        SELECT 1 FROM file_refs fr
        JOIN libraries l ON l.id = fr.library_id
        WHERE fr.document_id = d.id
          AND l.deleted_at IS NULL
          AND (
            l.visibility = 'ALL_USERS'
            OR EXISTS (
              SELECT 1 FROM library_access la
              WHERE la.library_id = l.id AND la.user_id = ${viewer.id}::uuid
            )
          )
      ))
      OR (d.source <> 'LIBRARY' AND (
        d.created_by_id = ${viewer.id}::uuid
        OR EXISTS (
          SELECT 1 FROM collection_items ci
          JOIN collections c ON c.id = ci.collection_id
          WHERE ci.document_id = d.id
            AND c.deleted_at IS NULL
            AND (
              c.owner_id = ${viewer.id}::uuid
              OR EXISTS (
                SELECT 1 FROM collection_shares cs
                WHERE cs.collection_id = c.id
                  AND cs.revoked_at IS NULL
                  AND (cs.grantee_user_id = ${viewer.id}::uuid OR cs.grantee_user_id IS NULL)
              )
            )
        )
      ))
    )
  `;
}

function filtersSql(filters: SearchFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];

  if (filters.categoryId !== undefined) {
    clauses.push(Prisma.sql`d.category_id = ${filters.categoryId}::uuid`);
  }
  if (filters.libraryId !== undefined) {
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1 FROM file_refs fl
      JOIN libraries ll ON ll.id = fl.library_id
      WHERE fl.document_id = d.id AND fl.library_id = ${filters.libraryId}::uuid
        AND ll.deleted_at IS NULL
    )`);
  }

  return Prisma.join(clauses, ' AND ');
}

// processingError is capped at 2000 characters (docs/03 §3.3.10): a stack trace or an HTML error page
// from a sibling container must not become the largest column in the table.
const MAX_ERROR_CHARS = 2000;

function truncate(message: string | null): string | null {
  if (message === null) return null;
  return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

type CounterRow = {
  canonical_status: string;
  preview_status: string;
  markdown_status: string;
  categorization_status: string;
  vectorization_status: string;
  count: bigint;
};

function emptyCounters(): StepStatusCounters {
  const zeroes = (): Record<StepStatus, number> => ({
    PENDING: 0,
    DONE: 0,
    FAILED: 0,
    SKIPPED: 0,
  });
  // Written out rather than derived: a type assertion is forbidden here (docs/14 §14.1), and the
  // compiler should be the one checking that every step is present.
  return {
    total: 0,
    steps: {
      canonical: zeroes(),
      preview: zeroes(),
      markdown: zeroes(),
      categorization: zeroes(),
      vectorization: zeroes(),
    },
  };
}

function add(
  counters: StepStatusCounters,
  step: DocumentStep,
  status: string,
  count: number,
): void {
  const parsed = stepStatusSchema.safeParse(status);
  if (!parsed.success) return;
  counters.steps[step][parsed.data] += count;
}

@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<Document | null> {
    const row = await clientOf(this.prisma, tx).document.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async updateProcessing(
    id: string,
    update: ProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Document> {
    const steps = update.steps ?? {};
    const client = clientOf(this.prisma, tx);

    // A step records its own reason and must not disturb its neighbours', so the column is patched
    // with jsonb concatenation — the typed client can only replace the whole value. Nulls are
    // stripped rather than stored: "no reason" is the absence of a key (docs/03 §3.3.10).
    if (update.skipReasons !== undefined) {
      const patch = Object.fromEntries(
        Object.entries(update.skipReasons).filter(([, reason]) => reason !== null),
      );
      const cleared = Object.entries(update.skipReasons)
        .filter(([, reason]) => reason === null)
        .map(([step]) => step);
      await client.$executeRaw`
        UPDATE documents
           SET skip_reasons = (coalesce(skip_reasons, '{}'::jsonb) - ${cleared}::text[])
                              || ${patch}::jsonb
         WHERE id = ${id}::uuid`;
    }

    const row = await client.document.update({
      where: { id },
      data: {
        ...(steps.canonical === undefined ? {} : { canonicalStatus: steps.canonical }),
        ...(steps.preview === undefined ? {} : { previewStatus: steps.preview }),
        ...(steps.markdown === undefined ? {} : { markdownStatus: steps.markdown }),
        ...(steps.categorization === undefined
          ? {}
          : { categorizationStatus: steps.categorization }),
        ...(steps.vectorization === undefined ? {} : { vectorizationStatus: steps.vectorization }),
        ...(update.pageCount === undefined ? {} : { pageCount: update.pageCount }),
        ...(update.markdown === undefined ? {} : { markdown: update.markdown }),
        ...(update.ocrUsed === undefined ? {} : { ocrUsed: update.ocrUsed }),
        ...(update.processingError === undefined
          ? {}
          : { processingError: truncate(update.processingError) }),
        ...(update.failedStep === undefined ? {} : { failedStep: update.failedStep }),
        ...(update.categoryId === undefined ? {} : { categoryId: update.categoryId }),
        ...(update.categorySource === undefined ? {} : { categorySource: update.categorySource }),
      },
    });
    return toDomain(row);
  }

  // One pass over the table rather than twenty count queries: every step column is aggregated in
  // the same scan (docs/05 §5.8).
  async countByStepStatus(tx?: TransactionHandle): Promise<StepStatusCounters> {
    const rows = await clientOf(this.prisma, tx).$queryRaw<CounterRow[]>`
      SELECT canonical_status, preview_status, markdown_status,
             categorization_status, vectorization_status, count(*) AS count
      FROM documents
      WHERE deleted_at IS NULL
      GROUP BY 1, 2, 3, 4, 5
    `;

    const counters = emptyCounters();
    for (const row of rows) {
      const count = Number(row.count);
      counters.total += count;
      add(counters, 'canonical', row.canonical_status, count);
      add(counters, 'preview', row.preview_status, count);
      add(counters, 'markdown', row.markdown_status, count);
      add(counters, 'categorization', row.categorization_status, count);
      add(counters, 'vectorization', row.vectorization_status, count);
    }
    return counters;
  }

  async listReadable(
    viewer: Viewer,
    query: ListDocumentsInput,
    tx?: TransactionHandle,
  ): Promise<DocumentPage> {
    const cursor = decodeCursor(query.cursor);

    const rows = await clientOf(this.prisma, tx).document.findMany({
      where: {
        deletedAt: null,
        ...readableBy(viewer),
        ...filters(query),
        ...(cursor === null
          ? {}
          : {
              // Newest first (docs/07 §7.3), so the page continues *below* the cursor.
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }),
      },
      include: LIST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ at: last.createdAt, id: last.id })
        : null;

    return { items: page.map(toListItem), nextCursor };
  }

  // Documents whose files sit directly in one folder, by title (docs/07 §7.3). The folder match is
  // a string operation on the path, so the ids come from raw SQL; the rows themselves then load
  // through the same include and mapper as every other list.
  async listInFolder(
    libraryId: string,
    folder: string,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<DocumentPage> {
    const client = clientOf(this.prisma, tx);
    const cursor = decodeTextCursor(query.cursor);

    const keys = await client.$queryRaw<{ id: string; title: string }[]>`
      SELECT DISTINCT d.id, d.title
      FROM documents d
      JOIN file_refs f ON f.document_id = d.id
      WHERE d.deleted_at IS NULL
        AND f.library_id = ${libraryId}::uuid
        AND (${folder} = '' OR f.path LIKE ${folder} || '/%')
        AND position('/' in CASE
              WHEN ${folder} = '' THEN f.path
              ELSE substring(f.path from char_length(${folder}) + 2)
            END) = 0
        AND (
          ${cursor === null}::boolean
          OR (d.title, d.id::text) > (${cursor?.key ?? ''}, ${cursor?.id ?? ''})
        )
      ORDER BY d.title ASC, d.id ASC
      LIMIT ${query.limit + 1}
    `;

    const page = keys.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      keys.length > query.limit && last !== undefined
        ? encodeTextCursor({ key: last.title, id: last.id })
        : null;

    const rows = await client.document.findMany({
      where: { id: { in: page.map((key) => key.id) } },
      include: LIST_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return {
      // The raw query decided the order; the fetch by id does not preserve it.
      items: page.flatMap((key) => {
        const row = byId.get(key.id);
        return row === undefined ? [] : [toListItem(row)];
      }),
      nextCursor,
    };
  }

  // Full-text search (docs/04 §4.3): the generated search_vector, queried with websearch_to_tsquery
  // and snippeted by ts_headline. 🔒 Access and filters are inside the query, so the limit applies to
  // rows the caller may actually read.
  async searchByText(
    viewer: Viewer,
    query: string,
    filters: SearchFilters,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<SearchMatch[]> {
    const client = clientOf(this.prisma, tx);

    const rows = await client.$queryRaw<{ id: string; snippet: string }[]>`
      SELECT d.id,
             ts_headline(
               'simple',
               coalesce(d.markdown, d.title),
               websearch_to_tsquery('simple', ${query}),
               'MaxFragments=2, MinWords=5, MaxWords=24, StartSel=<mark>, StopSel=</mark>'
             ) AS snippet
      FROM documents d
      WHERE d.search_vector @@ websearch_to_tsquery('simple', ${query})
        AND ${readableSql(viewer)}
        AND ${filtersSql(filters)}
      ORDER BY ts_rank(d.search_vector, websearch_to_tsquery('simple', ${query})) DESC, d.id
      LIMIT ${limit}
    `;

    return this.hydrate(
      client,
      rows.map((row) => ({ id: row.id, snippet: row.snippet })),
    );
  }

  // Nearest chunks first, then one row per document: the best chunk wins and its text is the
  // snippet (docs/07 §7.3). The candidate pool is deliberately wider than the page, because several
  // of the nearest chunks often belong to the same document.
  async searchByVector(
    viewer: Viewer,
    embedding: number[],
    filters: SearchFilters,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<SearchMatch[]> {
    const client = clientOf(this.prisma, tx);
    const vector = `[${embedding.join(',')}]`;

    const rows = await client.$queryRaw<{ id: string; snippet: string }[]>`
      WITH nearest AS (
        SELECT k.document_id, k.content, (k.embedding <=> ${vector}::vector) AS distance
        FROM document_chunks k
        JOIN documents d ON d.id = k.document_id
        WHERE ${readableSql(viewer)}
          AND ${filtersSql(filters)}
        ORDER BY k.embedding <=> ${vector}::vector
        LIMIT ${limit * 5}
      ), best AS (
        SELECT DISTINCT ON (document_id) document_id AS id, distance, left(content, 300) AS snippet
        FROM nearest
        ORDER BY document_id, distance
      )
      SELECT id, snippet FROM best ORDER BY distance LIMIT ${limit}
    `;

    return this.hydrate(
      client,
      rows.map((row) => ({ id: row.id, snippet: row.snippet })),
    );
  }

  // Ranked ids → full list rows, in the order the ranking produced.
  private async hydrate(
    client: ReturnType<typeof clientOf>,
    ranked: { id: string; snippet: string | null }[],
  ): Promise<SearchMatch[]> {
    if (ranked.length === 0) return [];

    const rows = await client.document.findMany({
      where: { id: { in: ranked.map((entry) => entry.id) } },
      include: LIST_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ranked.flatMap((entry, index) => {
      const row = byId.get(entry.id);
      return row === undefined
        ? []
        : [{ item: toListItem(row), rank: index + 1, snippet: entry.snippet }];
    });
  }

  async listInCollection(
    collectionId: string,
    viewer: Viewer,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<DocumentPage> {
    const cursor = decodeCursor(query.cursor);

    const rows = await clientOf(this.prisma, tx).document.findMany({
      where: {
        deletedAt: null,
        collectionItems: { some: { collectionId } },
        ...readableBy(viewer),
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.at } },
                { createdAt: cursor.at, id: { lt: cursor.id } },
              ],
            }),
      },
      include: LIST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toListItem),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  async findReadableById(
    id: string,
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<DocumentDetail | null> {
    const row = await clientOf(this.prisma, tx).document.findFirst({
      where: { id, deletedAt: null, ...readableBy(viewer) },
      include: {
        ...LIST_INCLUDE,
        createdBy: { select: { id: true, displayName: true } },
        // 🔒 The file locations a viewer is shown are only those they could have reached anyway
        // (docs/07 §7.3): an admin sees every ref, everyone else only their visible libraries.
        fileRefs: {
          where: { library: { deletedAt: null, ...visibleLibrary(viewer) } },
          select: {
            path: true,
            status: true,
            libraryId: true,
            library: { select: { name: true } },
          },
          orderBy: { path: 'asc' },
        },
      },
    });
    if (row === null) return null;

    return {
      ...toListItem(row),
      fileRefs: row.fileRefs.map((ref) => ({
        libraryId: ref.libraryId,
        libraryName: ref.library.name,
        path: ref.path,
        status: ref.status,
      })),
      createdBy: row.createdBy,
    };
  }

  async updateMeta(
    id: string,
    input: UpdateDocumentMetaInput,
    tx?: TransactionHandle,
  ): Promise<Document> {
    const row = await clientOf(this.prisma, tx).document.update({
      where: { id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
        ...(input.categorySource === undefined ? {} : { categorySource: input.categorySource }),
      },
    });
    return toDomain(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).document.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt },
    });
  }

  // No `deletedAt` filter on purpose: a soft-deleted document still owns its artifacts.
  async filterExistingIds(ids: string[], tx?: TransactionHandle): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).document.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async findActiveByContentHash(
    contentHash: string,
    tx?: TransactionHandle,
  ): Promise<Document | null> {
    const row = await clientOf(this.prisma, tx).document.findFirst({
      where: { contentHash, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  async findOrCreateByContentHash(
    input: CreateDocumentInput,
    tx?: TransactionHandle,
  ): Promise<DocumentUpsert> {
    const existing = await this.findActiveByContentHash(input.contentHash, tx);
    if (existing !== null) return { document: existing, created: false };

    try {
      const row = await clientOf(this.prisma, tx).document.create({
        data: {
          contentHash: input.contentHash,
          source: input.source,
          mimeType: input.mimeType,
          ext: input.ext,
          sizeBytes: input.sizeBytes,
          title: input.title,
          createdById: input.createdById ?? null,
          scanSetId: input.scanSetId ?? null,
        },
      });
      return { document: toDomain(row), created: true };
    } catch (error) {
      // documents_content_hash_active_uq (docs/04 §4.3): another ingest inserted the same content
      // between the read above and this write. Whoever lost simply attaches to the winner, so
      // identical content still yields exactly one document.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findActiveByContentHash(input.contentHash, tx);
        if (winner !== null) return { document: winner, created: false };
      }
      throw error;
    }
  }
}
