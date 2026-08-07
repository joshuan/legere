import { Injectable } from '@nestjs/common';
import { Prisma, type Document as PrismaDocument } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { z } from 'zod';
import {
  availabilityOf,
  isFileReadable,
  originOf,
  type Document,
  type SkipReasons,
} from '../../domain/entities/document';
import {
  DOCUMENT_STEPS,
  autoValuesSchema,
  type AutoValues,
  type Availability,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import {
  stepSkipReasonSchema,
  stepStatusSchema,
  type StepStatus,
} from '../../../shared/contracts/enums';
import { FileRepository, type DocumentFile } from '../../domain/repositories/file.repository';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentFileRefView,
  type DocumentFileView,
  type DocumentListItem,
  type DocumentPage,
  type ListDocumentsInput,
  type ProcessingUpdate,
  type SearchFilters,
  type SearchMatch,
  type StepStatusCounters,
  type UpdateDocumentMetaInput,
  type Viewer,
} from '../../domain/repositories/document.repository';
import {
  decodeCursor,
  decodeTextCursor,
  encodeCursor,
  encodeTextCursor,
  type Cursor,
} from './cursor';
import { clientOf } from './prisma-client';
import type { PrismaTx } from './prisma-unit-of-work';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaDocument): Document {
  return {
    id: row.id,
    pageCount: row.pageCount,
    title: row.title,
    markdown: row.markdown,
    steps: {
      canonical: row.canonicalStatus,
      preview: row.previewStatus,
      markdown: row.markdownStatus,
      analysis: row.analysisStatus,
      vectorization: row.vectorizationStatus,
    },
    processingError: row.processingError,
    skipReasons: toSkipReasons(row.skipReasons),
    languages: row.languages,
    auto: toAutoValues(row.autoValues),
    // A DATE column comes back as a Date at UTC midnight; the domain speaks yyyy-mm-dd, which is
    // what the paper says and what no time zone can shift.
    documentDate: row.documentDate === null ? null : row.documentDate.toISOString().slice(0, 10),
    country: row.country,
    city: row.city,
    failedStep: row.failedStep,
    ocrUsed: row.ocrUsed,
    description: row.description,
    titleSource: row.titleSource,
    typeId: row.typeId,
    typeSource: row.typeSource,
    createdById: row.createdById,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

// What a list row needs beyond its own columns is now the document's files (docs/03 §3.3.10) — the
// count, the first extension, the weight, the origin and the availability are all read off them.
// Those are fetched for the whole page at once rather than per row (see `toItems`); only the
// documentType still travels with the row itself.
const LIST_INCLUDE = {
  documentType: { select: { id: true, slug: true, name: true } },
} as const;

type ListRow = PrismaDocument & {
  documentType: { id: string; slug: string; name: string } | null;
};

// The column is jsonb, so what comes back is `unknown` as far as types go: parse it rather than
// trusting it, and treat anything unrecognised as "no reason recorded".
// Anything unreadable is treated as "nothing was recorded": the auto values are an explanation, and
// an explanation that cannot be parsed must never take a document down with it.
// yyyy-mm-dd → the DATE column. Parsed as UTC so the stored day is the day that was written, not
// the day it happened to be wherever the server stands.
function toDateColumn(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

function toAutoValues(value: unknown): AutoValues {
  const parsed = autoValuesSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

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

// A library file whose bytes can still be read: at least one HASHED ref in a library that is itself
// active (docs/03 §3.3.10). A managed file needs no such thing.
const LIVE_REF: Prisma.FileRefListRelationFilter = {
  some: { status: 'HASHED', library: { deletedAt: null } },
};

const READABLE_FILE: Prisma.FileWhereInput = {
  OR: [{ origin: 'MANAGED' }, { refs: LIVE_REF }],
};

const UNREADABLE_FILE: Prisma.FileWhereInput = {
  origin: 'LIBRARY',
  refs: { none: { status: 'HASHED', library: { deletedAt: null } } },
};

// What a share can carry to this viewer: every live collection somebody shared with them by name or
// with the whole instance, paired with the person who owns it (docs/03 §3.3.15).
//
// Read as values rather than written as a clause because the share branch of the rule below needs
// `collection.ownerId = document.createdById` — a comparison between two tables. Prisma's object
// filters compare a field to a value or to a field of the *same* model and refuse anything else, so
// the raw dialect states it in one line and this one pairs each sharer with the collections they
// shared. The pairing is what keeps the branch exact: a document is reached through a collection
// only when that collection's owner is also its creator.
type ShareReach = ReadonlyArray<{ ownerId: string; collectionIds: string[] }>;

async function shareReach(client: PrismaTx, viewer: Viewer): Promise<ShareReach> {
  if (viewer.role === 'ADMIN') return [];

  const rows = await client.collection.findMany({
    where: {
      deletedAt: null,
      shares: {
        some: {
          revokedAt: null,
          // A share with no grantee is instance-wide (docs/03 §3.3.15).
          OR: [{ granteeUserId: viewer.id }, { granteeUserId: null }],
        },
      },
    },
    select: { id: true, ownerId: true },
  });

  const byOwner = new Map<string, string[]>();
  for (const row of rows) {
    const owned = byOwner.get(row.ownerId);
    if (owned === undefined) byOwner.set(row.ownerId, [row.id]);
    else owned.push(row.id);
  }
  return [...byOwner].map(([ownerId, collectionIds]) => ({ ownerId, collectionIds }));
}

// The access rule of docs/03 §3.4, expressed once, in SQL, so a page of results never has to be
// filtered afterwards — and no route can forget to apply it.
function readableBy(viewer: Viewer, reach: ShareReach): Prisma.DocumentWhereInput {
  if (viewer.role === 'ADMIN') return {};

  const branches: Prisma.DocumentWhereInput[] = [
    // Through a library: any file of the document is a library file lying in a library the viewer
    // can see. A ref that has gone MISSING still counts — it makes the document unavailable, not
    // invisible, and the canonical PDF reads either way.
    {
      files: {
        some: {
          file: {
            origin: 'LIBRARY',
            refs: { some: { library: { deletedAt: null, ...visibleLibrary(viewer) } } },
          },
        },
      },
    },
    // Or because they made it: an upload, a split, a combine (docs/03 §3.3.10).
    { createdById: viewer.id },
  ];

  // Or because the person who made it shared it, in a collection of their own (docs/03 §3.3.15): a
  // share carries the documents in the collection **that its owner created**, and nothing else.
  //
  // 🔒 Two conditions, and each is a hole without the other. Without "its owner created it", a
  // grantee re-lends what they were lent: they add the borrowed document to a collection of their
  // own and share that with the instance (SEC-01). Without "no library file of its own", a user
  // widens a library, which is the admin's to control and not a user's to give away (docs/03 §3.4).
  //
  // "Owned by the viewer" is not an alternative here: a collection of the viewer's own only reaches
  // documents the viewer created, which the branch above already grants.
  if (reach.length > 0) {
    branches.push({
      files: { none: { file: { origin: 'LIBRARY' } } },
      OR: reach.map(({ ownerId, collectionIds }) => ({
        createdById: ownerId,
        collectionItems: { some: { collectionId: { in: collectionIds } } },
      })),
    });
  }

  return { OR: branches };
}

// Newest first (docs/07 §7.3), so a page continues *below* the cursor.
function cursorFilter(cursor: Cursor): Prisma.DocumentWhereInput {
  return {
    OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }],
  };
}

function visibleLibrary(viewer: Viewer): Prisma.LibraryWhereInput {
  if (viewer.role === 'ADMIN') return {};
  return { OR: [{ visibility: 'ALL_USERS' }, { access: { some: { userId: viewer.id } } }] };
}

function filters(query: ListDocumentsInput): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = {};
  // Every file-shaped filter is another clause on `files`, so they are collected into one AND list
  // rather than overwriting each other on a single key.
  const and: Prisma.DocumentWhereInput[] = [];

  if (query.libraryId !== undefined) {
    and.push({
      files: {
        some: {
          file: { refs: { some: { libraryId: query.libraryId, library: { deletedAt: null } } } },
        },
      },
    });
  }
  if (query.typeId !== undefined) where.typeId = query.typeId;
  if (query.personId !== undefined) where.people = { some: { personId: query.personId } };
  if (query.subjectId !== undefined) where.subjects = { some: { subjectId: query.subjectId } };
  if (query.year !== undefined) {
    // A calendar year in UTC, which is the zone the DATE column is read and written in.
    where.documentDate = {
      gte: new Date(Date.UTC(query.year, 0, 1)),
      lt: new Date(Date.UTC(query.year + 1, 0, 1)),
    };
  }

  // Origin is derived from the files, so it filters on the same condition it is computed from
  // (docs/03 §3.3.10): LIBRARY means at least one library file, MANAGED means none at all.
  if (query.origin === 'LIBRARY') {
    and.push({ files: { some: { file: { origin: 'LIBRARY' } } } });
  }
  if (query.origin === 'MANAGED') {
    and.push({ files: { none: { file: { origin: 'LIBRARY' } } } });
  }

  if (query.availability !== undefined) {
    and.push(availabilityFilter(query.availability));
  }

  if (query.processing !== undefined) {
    // "Processing" means any step is still PENDING (docs/03 §3.3.10).
    const pending: Prisma.DocumentWhereInput[] = [
      { canonicalStatus: 'PENDING' },
      { previewStatus: 'PENDING' },
      { markdownStatus: 'PENDING' },
      { analysisStatus: 'PENDING' },
      { vectorizationStatus: 'PENDING' },
    ];
    and.push(query.processing ? { OR: pending } : { NOT: { OR: pending } });
  }

  // One filter made of two parameters (docs/07 §7.3): a step alone says nothing about what to keep,
  // and the route refuses that half before it gets here.
  if (query.step !== undefined && query.stepStatus !== undefined) {
    and.push(stepStatusFilter(query.step, query.stepStatus));
  }

  return and.length === 0 ? where : { ...where, AND: and };
}

// Which column each step of the pipeline records itself in (docs/03 §3.3.10). A step is a name in
// the API and a column in the table; this is the one place the two are tied together.
const STEP_STATUS_FILTER: Record<DocumentStep, (status: StepStatus) => Prisma.DocumentWhereInput> =
  {
    canonical: (status) => ({ canonicalStatus: status }),
    preview: (status) => ({ previewStatus: status }),
    markdown: (status) => ({ markdownStatus: status }),
    analysis: (status) => ({ analysisStatus: status }),
    vectorization: (status) => ({ vectorizationStatus: status }),
  };

function stepStatusFilter(step: DocumentStep, status: StepStatus): Prisma.DocumentWhereInput {
  return STEP_STATUS_FILTER[step](status);
}

// Availability is derived, so it filters on the same condition it is computed from (docs/03
// §3.3.10). A document with no files at all is nobody's AVAILABLE, hence the `some: {}` guard.
function availabilityFilter(availability: Availability): Prisma.DocumentWhereInput {
  switch (availability) {
    case 'AVAILABLE':
      return { AND: [{ files: { some: {} } }, { files: { none: { file: UNREADABLE_FILE } } }] };
    case 'PARTIAL':
      return {
        AND: [
          { files: { some: { file: READABLE_FILE } } },
          { files: { some: { file: UNREADABLE_FILE } } },
        ],
      };
    case 'UNAVAILABLE':
      return { AND: [{ files: { some: {} } }, { files: { none: { file: READABLE_FILE } } }] };
  }
}

// The access rule of docs/03 §3.4 again, this time as SQL. Search ranks and limits inside the
// query — a limit of 20 has to mean 20 readable rows — and the query builder cannot express
// ts_rank or the vector operator, so the rule exists in both dialects. They are tested together by
// the same e2e cases, which is the only thing keeping them saying the same thing.
function readableSql(viewer: Viewer): Prisma.Sql {
  if (viewer.role === 'ADMIN') return Prisma.sql`d.deleted_at IS NULL`;

  return Prisma.sql`
    d.deleted_at IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM document_files df
        JOIN files fi ON fi.id = df.file_id
        JOIN file_refs fr ON fr.file_id = fi.id
        JOIN libraries l ON l.id = fr.library_id
        WHERE df.document_id = d.id
          AND fi.origin = 'LIBRARY'
          AND l.deleted_at IS NULL
          AND (
            l.visibility = 'ALL_USERS'
            OR EXISTS (
              SELECT 1 FROM library_access la
              WHERE la.library_id = l.id AND la.user_id = ${viewer.id}::uuid
            )
          )
      )
      OR d.created_by_id = ${viewer.id}::uuid
      OR (
      NOT EXISTS (
        SELECT 1 FROM document_files df2
        JOIN files fi2 ON fi2.id = df2.file_id
        WHERE df2.document_id = d.id AND fi2.origin = 'LIBRARY'
      )
      AND EXISTS (
        SELECT 1 FROM collection_items ci
        JOIN collections c ON c.id = ci.collection_id
        WHERE ci.document_id = d.id
          AND c.deleted_at IS NULL
          AND c.owner_id = d.created_by_id
          AND EXISTS (
            SELECT 1 FROM collection_shares cs
            WHERE cs.collection_id = c.id
              AND cs.revoked_at IS NULL
              AND (cs.grantee_user_id = ${viewer.id}::uuid OR cs.grantee_user_id IS NULL)
          )
      ))
    )
  `;
}

// The full-text search itself, as SQL (docs/04 §4.3, docs/07 §7.3).
//
// 🔒 Two stages, and the shape does as much of the work as the bound does: `matches` finds and ranks,
// `LIMIT` cuts, and only then does ts_headline run — over at most `limit` rows, and over a bounded
// prefix of each. Written as one flat SELECT it was ts_headline over the whole of an unbounded `text`
// column holding OCR output, for every row the planner chose to project, on a request any signed-in
// user can repeat as fast as they like. The tsquery is built once in a CTE of its own instead of
// three times over — once for the match, once for the rank, once for the headline.
//
// `MATERIALIZED` on both is the point rather than a hint: without it the planner may fold either CTE
// back into the outer query and undo exactly the two properties this shape exists for.
//
// Separated from the method so the query can be read without a database: every value still travels
// as a bound parameter through `Prisma.sql`, and a test asserts that it does (docs/14 §14.1).
export function searchByTextSql(
  viewer: Viewer,
  query: string,
  filters: SearchFilters,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    WITH q AS MATERIALIZED (
      SELECT websearch_to_tsquery('simple', ${query}) AS tsq
    ), matches AS MATERIALIZED (
      SELECT d.id,
             ts_rank(d.search_vector, q.tsq) AS score,
             -- The cast is load-bearing: a JavaScript number binds as bigint, and there is no
             -- left(text, bigint).
             left(coalesce(d.markdown, d.title), ${MAX_HEADLINE_CHARS}::int) AS excerpt
      FROM documents d, q
      WHERE d.search_vector @@ q.tsq
        AND ${readableSql(viewer)}
        AND ${filtersSql(filters)}
      ORDER BY score DESC, d.id
      LIMIT ${limit}
    )
    SELECT m.id,
           ts_headline(
             'simple',
             m.excerpt,
             q.tsq,
             'MaxFragments=2, MinWords=5, MaxWords=24, StartSel=<mark>, StopSel=</mark>'
           ) AS snippet
    FROM matches m, q
    ORDER BY m.score DESC, m.id
  `;
}

function filtersSql(filters: SearchFilters): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`TRUE`];

  if (filters.typeId !== undefined) {
    clauses.push(Prisma.sql`d.type_id = ${filters.typeId}::uuid`);
  }
  if (filters.libraryId !== undefined) {
    clauses.push(Prisma.sql`EXISTS (
      SELECT 1 FROM document_files df
      JOIN file_refs fl ON fl.file_id = df.file_id
      JOIN libraries ll ON ll.id = fl.library_id
      WHERE df.document_id = d.id AND fl.library_id = ${filters.libraryId}::uuid
        AND ll.deleted_at IS NULL
    )`);
  }

  return Prisma.join(clauses, ' AND ');
}

// processingError is capped at 2000 characters (docs/03 §3.3.10): a stack trace or an HTML error page
// from a sibling container must not become the largest column in the table.
const MAX_ERROR_CHARS = 2000;

// 🔒 How much of a document's Markdown the search snippet is cut from. `documents.markdown` is an
// unbounded `text` column holding OCR output — a 300-page scan is megabytes of it — and ts_headline
// re-parses whatever it is given, once per row returned. A search of 50 rows is therefore work
// proportional to the largest documents in the archive, on a request any signed-in user can repeat
// as fast as they like (docs/07 §7.3).
//
// 8000 characters is about four pages of text, which is where a snippet is worth reading from: what
// a document is about is said near its beginning, and the snippet shows two fragments of two dozen
// words. Nothing about *which* documents match changes — matching is `search_vector`, generated over
// the whole column (docs/04 §4.3) — so a term that appears only on page forty still finds its
// document; the snippet then opens at the top of the text instead of at that term.
const MAX_HEADLINE_CHARS = 8000;

function truncate(message: string | null): string | null {
  if (message === null) return null;
  return message.length <= MAX_ERROR_CHARS ? message : `${message.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

type CounterRow = {
  canonical_status: string;
  preview_status: string;
  markdown_status: string;
  analysis_status: string;
  vectorization_status: string;
  count: bigint;
};

function emptyCounters(): StepStatusCounters {
  const zeroes = (): Record<StepStatus, number> => ({
    PENDING: 0,
    RUNNING: 0,
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
      analysis: zeroes(),
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
  constructor(
    private readonly prisma: PrismaService,
    // A document is what its files say it is (docs/03 §3.3.10), and the list needs that for a whole
    // page at once — so the composition is read through the same repository the rest of the server
    // uses, in two batched queries rather than one per row.
    private readonly files: FileRepository,
  ) {}

  async findById(id: string, tx?: TransactionHandle): Promise<Document | null> {
    const row = await clientOf(this.prisma, tx).document.findUnique({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async create(input: CreateDocumentInput, tx?: TransactionHandle): Promise<Document> {
    const row = await clientOf(this.prisma, tx).document.create({
      data: { title: input.title, createdById: input.createdById ?? null },
    });
    return toDomain(row);
  }

  async updateProcessing(
    id: string,
    update: ProcessingUpdate,
    tx?: TransactionHandle,
  ): Promise<Document> {
    const steps = update.steps ?? {};
    const client = clientOf(this.prisma, tx);

    // A step records its own reason and must not disturb its neighbours', so the column is patched
    // Merged, not replaced: each step records what it worked out without erasing what an earlier
    // step recorded (docs/03 §3.3.10).
    if (update.auto !== undefined) {
      await client.$executeRaw`
        UPDATE documents
           SET auto_values = coalesce(auto_values, '{}'::jsonb) || ${update.auto}::jsonb
         WHERE id = ${id}::uuid`;
    }

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
        ...(steps.analysis === undefined ? {} : { analysisStatus: steps.analysis }),
        ...(steps.vectorization === undefined ? {} : { vectorizationStatus: steps.vectorization }),
        ...(update.pageCount === undefined ? {} : { pageCount: update.pageCount }),
        ...(update.languages === undefined ? {} : { languages: update.languages }),
        ...(update.documentDate === undefined
          ? {}
          : { documentDate: toDateColumn(update.documentDate) }),
        ...(update.country === undefined ? {} : { country: update.country }),
        ...(update.city === undefined ? {} : { city: update.city }),
        ...(update.markdown === undefined ? {} : { markdown: update.markdown }),
        ...(update.ocrUsed === undefined ? {} : { ocrUsed: update.ocrUsed }),
        ...(update.processingError === undefined
          ? {}
          : { processingError: truncate(update.processingError) }),
        ...(update.failedStep === undefined ? {} : { failedStep: update.failedStep }),
        ...(update.typeId === undefined ? {} : { typeId: update.typeId }),
        ...(update.typeSource === undefined ? {} : { typeSource: update.typeSource }),
        ...(update.title === undefined ? {} : { title: update.title }),
        ...(update.titleSource === undefined ? {} : { titleSource: update.titleSource }),
        ...(update.description === undefined ? {} : { description: update.description }),
      },
    });
    return toDomain(row);
  }

  // One pass over the table rather than twenty count queries: every step column is aggregated in
  // the same scan (docs/05 §5.8).
  async listYears(
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<Array<{ year: number; count: number }>> {
    // 🔒 The same access rule as every list: a year is only a year if this viewer has a document in
    // it (docs/03 §3.4).
    const client = clientOf(this.prisma, tx);
    const rows = await client.document.groupBy({
      by: ['documentDate'],
      where: {
        deletedAt: null,
        documentDate: { not: null },
        ...readableBy(viewer, await shareReach(client, viewer)),
      },
      _count: { _all: true },
    });

    const years = new Map<number, number>();
    for (const row of rows) {
      if (row.documentDate === null) continue;
      const year = row.documentDate.getUTCFullYear();
      years.set(year, (years.get(year) ?? 0) + row._count._all);
    }
    return [...years.entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => b.year - a.year);
  }

  async listStalePendingIds(
    olderThan: Date,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<string[]> {
    const rows = await clientOf(this.prisma, tx).document.findMany({
      where: {
        deletedAt: null,
        updatedAt: { lt: olderThan },
        OR: [
          { canonicalStatus: 'PENDING' },
          { previewStatus: 'PENDING' },
          { markdownStatus: 'PENDING' },
          { analysisStatus: 'PENDING' },
          { vectorizationStatus: 'PENDING' },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async listIdsByStepStatus(
    step: DocumentStep,
    status: StepStatus,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<string[]> {
    const rows = await clientOf(this.prisma, tx).document.findMany({
      where: { deletedAt: null, ...stepStatusFilter(step, status) },
      select: { id: true },
      // Newest first, like every other list of documents: a capped repair starts with what was
      // filed last (docs/07 §7.3).
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async countByStepStatus(tx?: TransactionHandle): Promise<StepStatusCounters> {
    const rows = await clientOf(this.prisma, tx).$queryRaw<CounterRow[]>`
      SELECT canonical_status, preview_status, markdown_status,
             analysis_status, vectorization_status, count(*) AS count
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
      add(counters, 'analysis', row.analysis_status, count);
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
    const client = clientOf(this.prisma, tx);

    // 🔒 Three independent conditions, each of which may be an `OR` of its own, so they are ANDed
    // as a list rather than spread into one object: spreading lets the last `OR` key win, and the
    // last one here is the cursor — which would drop the access rule from every page but the first.
    const rows = await client.document.findMany({
      where: {
        deletedAt: null,
        AND: [
          readableBy(viewer, await shareReach(client, viewer)),
          filters(query),
          ...(cursor === null ? [] : [cursorFilter(cursor)]),
        ],
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

    return { items: await this.toItems(page, tx), nextCursor };
  }

  // Documents whose files sit directly in one folder, by title (docs/07 §7.3). The folder match is
  // a string operation on the path, so the ids come from raw SQL; the rows themselves then load
  // through the same include and mapper as every other list. A ref points at a file and the file at
  // a document (docs/03 §3.3.16), so the join goes through `document_files`.
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
      JOIN document_files df ON df.document_id = d.id
      JOIN file_refs f ON f.file_id = df.file_id
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

    // The raw query decided the order; the fetch by id does not preserve it.
    const ordered = page.flatMap((key) => {
      const row = byId.get(key.id);
      return row === undefined ? [] : [row];
    });

    return { items: await this.toItems(ordered, tx), nextCursor };
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

    const rows = await client.$queryRaw<{ id: string; snippet: string }[]>(
      searchByTextSql(viewer, query, filters, limit),
    );

    return this.hydrate(
      client,
      rows.map((row) => ({ id: row.id, snippet: row.snippet })),
      tx,
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
      tx,
    );
  }

  // Ranked ids → full list rows, in the order the ranking produced.
  private async hydrate(
    client: ReturnType<typeof clientOf>,
    ranked: { id: string; snippet: string | null }[],
    tx?: TransactionHandle,
  ): Promise<SearchMatch[]> {
    if (ranked.length === 0) return [];

    const rows = await client.document.findMany({
      where: { id: { in: ranked.map((entry) => entry.id) } },
      include: LIST_INCLUDE,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));

    // Rank is the place the engine gave the document, not the place it ends up in this array: a row
    // that vanished between the two queries leaves a gap rather than promoting everything below it.
    const found = ranked.flatMap((entry, index) => {
      const row = byId.get(entry.id);
      return row === undefined ? [] : [{ row, rank: index + 1, snippet: entry.snippet }];
    });
    const items = await this.toItems(
      found.map((entry) => entry.row),
      tx,
    );

    return items.flatMap((item, index) => {
      const entry = found[index];
      return entry === undefined ? [] : [{ item, rank: entry.rank, snippet: entry.snippet }];
    });
  }

  async listInCollection(
    collectionId: string,
    viewer: Viewer,
    query: { limit: number; cursor?: string | undefined },
    tx?: TransactionHandle,
  ): Promise<DocumentPage> {
    const cursor = decodeCursor(query.cursor);
    const client = clientOf(this.prisma, tx);

    const rows = await client.document.findMany({
      where: {
        deletedAt: null,
        collectionItems: { some: { collectionId } },
        // 🔒 ANDed as a list for the reason `listReadable` gives: the access rule and the cursor
        // are both an `OR`, and spread into one object only the cursor would survive.
        AND: [
          readableBy(viewer, await shareReach(client, viewer)),
          ...(cursor === null ? [] : [cursorFilter(cursor)]),
        ],
      },
      include: LIST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: await this.toItems(page, tx),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  // A whole page of rows plus what their files say about them, in two queries for the page rather
  // than two per row (docs/03 §3.3.10).
  private async toItems(rows: ListRow[], tx?: TransactionHandle): Promise<DocumentListItem[]> {
    if (rows.length === 0) return [];

    const byDocument = await this.files.listForDocuments(
      rows.map((row) => row.id),
      tx,
    );
    const liveRefs = await this.files.countLiveRefsForFiles(
      [...byDocument.values()].flat().map((file) => file.id),
      tx,
    );

    return rows.map((row) => {
      const files = byDocument.get(row.id) ?? [];
      return {
        document: toDomain(row),
        documentType: row.documentType,
        fileCount: files.length,
        primaryExt: files[0]?.ext ?? '',
        sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0n),
        origin: originOf(files.map((file) => file.origin)),
        availability: availabilityOf(files.map((file) => readable(file, liveRefs))),
      };
    });
  }

  async findReadableById(
    id: string,
    viewer: Viewer,
    tx?: TransactionHandle,
  ): Promise<DocumentDetail | null> {
    const client = clientOf(this.prisma, tx);
    const row = await client.document.findFirst({
      where: { id, deletedAt: null, ...readableBy(viewer, await shareReach(client, viewer)) },
      include: {
        ...LIST_INCLUDE,
        createdBy: { select: { id: true, displayName: true } },
        // A soft-deleted person stays on the documents that named them (ADR-015), so the link is
        // read whatever the catalogue now offers.
        people: { include: { person: true }, orderBy: { person: { name: 'asc' } } },
        subjects: {
          include: { subject: { include: { kind: true } } },
          orderBy: [{ subject: { kind: { name: 'asc' } } }, { subject: { name: 'asc' } }],
        },
      },
    });
    if (row === null) return null;

    const files = await this.files.listForDocument(id, tx);
    const fileIds = files.map((file) => file.id);
    const liveRefs = await this.files.countLiveRefsForFiles(fileIds, tx);

    // 🔒 The file locations a viewer is shown are only those they could have reached anyway
    // (docs/07 §7.3): an admin sees every ref, everyone else only their visible libraries. The
    // availability above is counted over *all* libraries — a file is no less readable for lying in
    // one this caller cannot see.
    const refRows =
      fileIds.length === 0
        ? []
        : await client.fileRef.findMany({
            where: {
              fileId: { in: fileIds },
              library: { deletedAt: null, ...visibleLibrary(viewer) },
            },
            select: {
              fileId: true,
              path: true,
              status: true,
              libraryId: true,
              library: { select: { name: true } },
            },
            orderBy: { path: 'asc' },
          });

    const refsByFile = new Map<string, DocumentFileRefView[]>(
      fileIds.map((fileId) => [fileId, []]),
    );
    for (const ref of refRows) {
      if (ref.fileId === null) continue;
      refsByFile.get(ref.fileId)?.push({
        libraryId: ref.libraryId,
        libraryName: ref.library.name,
        path: ref.path,
        status: ref.status,
      });
    }

    const fileViews: DocumentFileView[] = files.map((file) => ({
      ...file,
      available: readable(file, liveRefs),
      refs: refsByFile.get(file.id) ?? [],
    }));

    return {
      document: toDomain(row),
      documentType: row.documentType,
      people: row.people.map((link) => ({
        id: link.person.id,
        name: link.person.name,
        deleted: link.person.deletedAt !== null,
      })),
      subjects: row.subjects.map((link) => ({
        id: link.subject.id,
        kind: link.subject.kind.name,
        name: link.subject.name,
        deleted: link.subject.deletedAt !== null,
      })),
      files: fileViews,
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
        ...(input.languages === undefined ? {} : { languages: input.languages }),
        ...(input.country === undefined ? {} : { country: input.country }),
        ...(input.city === undefined ? {} : { city: input.city }),
        ...(input.typeId === undefined ? {} : { typeId: input.typeId }),
        ...(input.documentDate === undefined
          ? {}
          : { documentDate: toDateColumn(input.documentDate) }),
        ...(input.typeSource === undefined ? {} : { typeSource: input.typeSource }),
        ...(input.titleSource === undefined ? {} : { titleSource: input.titleSource }),
        ...(input.description === undefined ? {} : { description: input.description }),
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
}

// One file's readability, from the batch of ref counts the page was measured with.
function readable(file: DocumentFile, liveRefs: Map<string, number>): boolean {
  return isFileReadable(file.origin, liveRefs.get(file.id) ?? 0);
}
