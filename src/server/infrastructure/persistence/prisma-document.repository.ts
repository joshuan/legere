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
  DEFAULT_DOCUMENT_SORT,
  DOCUMENT_STEPS,
  autoValuesSchema,
  type AutoValues,
  type Availability,
  type DocumentGroupBy,
  type DocumentSort,
  type DocumentStep,
} from '../../../shared/contracts/documents';
import {
  extractedFieldsSchema,
  type ExtractedFields,
} from '../../../shared/contracts/document-fields';
import {
  stepSkipReasonSchema,
  stepStatusSchema,
  type StepStatus,
} from '../../../shared/contracts/enums';
import { purgeAfterOf, type File } from '../../domain/entities/file';
import { FileRepository } from '../../domain/repositories/file.repository';
import { AppConfig } from '../config/app-config';
import {
  DocumentRepository,
  type CreateDocumentInput,
  type DocumentDetail,
  type DocumentFileRefView,
  type DocumentFileView,
  type DocumentFilterInput,
  type DocumentGroupCount,
  type DocumentListItem,
  type DocumentName,
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
  decodeDocumentCursor,
  decodeTextCursor,
  encodeDocumentCursor,
  encodeTextCursor,
  type DocumentCursor,
} from './cursor';
import { folderPrefixPattern } from './like';
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
      fields: row.fieldsStatus,
      vectorization: row.vectorizationStatus,
    },
    processingError: row.processingError,
    skipReasons: toSkipReasons(row.skipReasons),
    extracted: toExtracted(row.extracted),
    lastEventAt: row.lastEventAt,
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
    pageFormat: row.pageFormat,
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

// The typed-fields answer (docs/03 §3.3.10a). Unparseable means "none": a reading that cannot be
// read back must never take the document down with it.
function toExtracted(value: unknown): ExtractedFields | null {
  if (value === null || value === undefined) return null;
  const parsed = extractedFieldsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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

// The three orders a document list may be read in (docs/07 §7.1). Each is newest-first with `id`
// as the tiebreak, so a page always continues *below* the cursor, and each is served by an index of
// its own (docs/04 §4.4).
const ORDER_BY: Record<DocumentSort, Prisma.DocumentOrderByWithRelationInput[]> = {
  // The undated *before* everything: a document whose date nobody has read yet is the one still
  // wanting attention, and NULLS LAST would file it behind a century of dated ones.
  documentDate: [{ documentDate: { sort: 'desc', nulls: 'first' } }, { id: 'desc' }],
  createdAt: [{ createdAt: 'desc' }, { id: 'desc' }],
  lastEventAt: [{ lastEventAt: 'desc' }, { id: 'desc' }],
};

// The sort key of the last row of a page, in the shape the cursor carries it: `yyyy-mm-dd` for the
// date on the document — null when it has none — and an ISO timestamp for the two clock orders.
function cursorKeyOf(sort: DocumentSort, row: PrismaDocument): string | null {
  switch (sort) {
    case 'documentDate':
      return row.documentDate === null ? null : row.documentDate.toISOString().slice(0, 10);
    case 'createdAt':
      return row.createdAt.toISOString();
    case 'lastEventAt':
      return row.lastEventAt.toISOString();
  }
}

function nextCursorOf(sort: DocumentSort, rows: ListRow[], limit: number): string | null {
  const last = rows.slice(0, limit).at(-1);
  if (rows.length <= limit || last === undefined) return null;
  return encodeDocumentCursor({ sort, key: cursorKeyOf(sort, last), id: last.id });
}

// 🔒 The keyset predicate for one order. Every branch of it is an `OR`, which is exactly why every
// caller ANDs it into a list rather than spreading it into the `where` object: spread, the last
// `OR` key wins and the access rule disappears from page two.
function cursorFilter(cursor: DocumentCursor): Prisma.DocumentWhereInput {
  switch (cursor.sort) {
    case 'createdAt': {
      const at = new Date(cursor.key ?? '');
      return { OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: cursor.id } }] };
    }
    case 'lastEventAt': {
      const at = new Date(cursor.key ?? '');
      return { OR: [{ lastEventAt: { lt: at } }, { lastEventAt: at, id: { lt: cursor.id } }] };
    }
    case 'documentDate': {
      // A nullable sort key, so the predicate has three branches rather than two: the undated rows
      // are a block of their own ahead of the dated ones, and which block the cursor sits in decides
      // what "below it" means.
      if (cursor.key === null) {
        return {
          OR: [
            // Still inside the undated block, continuing by id …
            { documentDate: null, id: { lt: cursor.id } },
            // … and then the whole dated block, all of which sorts after it.
            { documentDate: { not: null } },
          ],
        };
      }
      // Inside the dated block. `lt` and the equality both exclude NULL in SQL, so the undated rows
      // this page already passed cannot come back.
      const date = new Date(`${cursor.key}T00:00:00.000Z`);
      return {
        OR: [{ documentDate: { lt: date } }, { documentDate: date, id: { lt: cursor.id } }],
      };
    }
  }
}

function visibleLibrary(viewer: Viewer): Prisma.LibraryWhereInput {
  if (viewer.role === 'ADMIN') return {};
  return { OR: [{ visibility: 'ALL_USERS' }, { access: { some: { userId: viewer.id } } }] };
}

function filters(query: DocumentFilterInput): Prisma.DocumentWhereInput {
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
  // Both subject filters land on the same relation, so they are ANDed rather than assigned to the
  // one `subjects` key: naming a kind and a thing of another kind must find nothing, not the thing.
  if (query.subjectId !== undefined) {
    and.push({ subjects: { some: { subjectId: query.subjectId } } });
  }
  // A kind, not a thing: served by `subjects(kind_id)` and `document_subjects(subject_id)`, which
  // the schema already carries (docs/04 §4.4).
  if (query.subjectKindId !== undefined) {
    and.push({ subjects: { some: { subject: { kindId: query.subjectKindId } } } });
  }
  // Exact equality, on the value the document itself carries: the link that leads here was built
  // from that value (docs/11 §11.5). The partial indexes of docs/04 §4.4 serve both.
  if (query.country !== undefined) where.country = query.country;
  if (query.city !== undefined) where.city = query.city;
  // The documents one dimension cannot place. Expressed as the absence it is — a null column, an
  // empty relation — rather than as a sentinel value, because there is no id that means "none"
  // (docs/07 §7.3).
  if (query.unassigned !== undefined) {
    and.push(unassignedIn(query.unassigned));
  }
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
      { fieldsStatus: 'PENDING' },
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
const STEP_STATUS_FILTER: Record<
  DocumentStep,
  (status: StepStatus | undefined) => Prisma.DocumentWhereInput
> = {
  // An absent status is "any of them", which for one column is no condition at all rather than a
  // list of every value it could hold.
  canonical: (status) => (status === undefined ? {} : { canonicalStatus: status }),
  preview: (status) => (status === undefined ? {} : { previewStatus: status }),
  markdown: (status) => (status === undefined ? {} : { markdownStatus: status }),
  analysis: (status) => (status === undefined ? {} : { analysisStatus: status }),
  fields: (status) => (status === undefined ? {} : { fieldsStatus: status }),
  vectorization: (status) => (status === undefined ? {} : { vectorizationStatus: status }),
};

// Which documents a repair is asking about (docs/11 §11.13). Each absence widens the question by a
// level: a step and a status name one column and one value; a step alone, that column whatever it
// holds; neither, every document there is — which is the honest reading of "run the whole thing
// again" and the only one that does not need a special case downstream.
function stepStatusFilter(
  step: DocumentStep | undefined,
  status: StepStatus | undefined,
): Prisma.DocumentWhereInput {
  if (step === undefined) {
    // A status with no step would have to mean "any step in this state", which is a different
    // question with a different answer per column; the API does not offer it and neither does this.
    return {};
  }
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

// What "has no value here" means, one dimension at a time (docs/11 §11.3).
function unassignedIn(dimension: DocumentGroupBy): Prisma.DocumentWhereInput {
  switch (dimension) {
    case 'type':
      return { typeId: null };
    case 'year':
      return { documentDate: null };
    case 'country':
      return { country: null };
    case 'city':
      return { city: null };
    case 'person':
      return { people: { none: {} } };
    case 'subject':
      return { subjects: { none: {} } };
  }
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
  fields_status: string;
  vectorization_status: string;
  count: bigint;
};

function emptyCounters(): StepStatusCounters {
  const zeroes = (): Record<StepStatus, number> => ({
    PENDING: 0,
    QUEUED: 0,
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
      fields: zeroes(),
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
    // Only to date the earlier versions of a page: when the sweep will take one is a fact about a
    // file in the trash, and the viewer prints it beside the version (docs/05 §5.7a).
    private readonly config: AppConfig,
  ) {}

  private get trashRetentionDays(): number {
    return this.config.get('TRASH_RETENTION_DAYS');
  }

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

    // The typed-fields answer and its FTS projection land together — the projection is derived from
    // the answer and must never drift from it (docs/03 §3.3.10a). Raw, like auto_values above: the
    // values are a jsonb the typed client cannot say.
    if (update.extracted !== undefined) {
      await client.$executeRaw`
        UPDATE documents
           SET extracted = ${update.extracted}::jsonb,
               extracted_search_text = ${update.extractedSearchText ?? null}
         WHERE id = ${id}::uuid`;
    }

    const row = await client.document.update({
      where: { id },
      data: {
        ...(steps.canonical === undefined ? {} : { canonicalStatus: steps.canonical }),
        ...(steps.preview === undefined ? {} : { previewStatus: steps.preview }),
        ...(steps.markdown === undefined ? {} : { markdownStatus: steps.markdown }),
        ...(steps.analysis === undefined ? {} : { analysisStatus: steps.analysis }),
        ...(steps.fields === undefined ? {} : { fieldsStatus: steps.fields }),
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

    return [...countYears(rows).entries()]
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => b.year - a.year);
  }

  // The shelves of one dimension, counted under the filters in force (docs/07 §7.3).
  //
  // 🔒 Both halves of the question are the list's own: `readableBy` decides which documents are
  // counted at all, and `filters` narrows them exactly as the grid is narrowed — so a group's count
  // is the number of documents that group's own filter would put on the screen, and never a count
  // over documents this viewer cannot open (docs/03 §3.4). Written through the query builder rather
  // than as raw SQL for that reason: a second dialect of the filter set is a second thing to keep
  // in step, and the one that drifts is the one nobody reads.
  //
  // Every dimension is counted by grouping either a column of the document or a link table whose
  // primary key holds the document once — which is why the two filters that meet a document many
  // times (`libraryId`, `subjectKindId`) are not offered as dimensions (docs/07 §7.3).
  async countByGroup(
    viewer: Viewer,
    by: DocumentGroupBy,
    filter: DocumentFilterInput,
    tx?: TransactionHandle,
  ): Promise<DocumentGroupCount[]> {
    const client = clientOf(this.prisma, tx);
    const where: Prisma.DocumentWhereInput = {
      deletedAt: null,
      AND: [readableBy(viewer, await shareReach(client, viewer)), filters(filter)],
    };

    // The group everything else is in, counted with the same access rule and the same filters as the
    // shelves beside it. Zero means there is nothing to show and the section is not drawn at all.
    const unplaced = await client.document.count({
      where: { AND: [where, unassignedIn(by)] },
    });
    const rest = (groups: DocumentGroupCount[]): DocumentGroupCount[] =>
      unplaced === 0 ? groups : [...groups, { key: null, label: '', count: unplaced }];

    switch (by) {
      case 'year': {
        const rows = await client.document.groupBy({
          by: ['documentDate'],
          where: { ...where, documentDate: { not: null } },
          _count: { _all: true },
        });
        return rest(
          [...countYears(rows).entries()].map(([year, count]) => ({
            key: String(year),
            label: String(year),
            count,
          })),
        );
      }
      case 'country': {
        const rows = await client.document.groupBy({
          by: ['country'],
          where: { ...where, country: { not: null } },
          _count: { _all: true },
        });
        return rest(
          rows.flatMap((row) =>
            row.country === null
              ? []
              : // The label is what the document carries: an ISO code, which is what the link a
                // viewer follows from the details pane carries too (docs/11 §11.5).
                [{ key: row.country, label: row.country, count: row._count._all }],
          ),
        );
      }
      case 'city': {
        const rows = await client.document.groupBy({
          by: ['city'],
          where: { ...where, city: { not: null } },
          _count: { _all: true },
        });
        return rest(
          rows.flatMap((row) =>
            row.city === null ? [] : [{ key: row.city, label: row.city, count: row._count._all }],
          ),
        );
      }
      case 'type': {
        const rows = await client.document.groupBy({
          by: ['typeId'],
          where: { ...where, typeId: { not: null } },
          _count: { _all: true },
        });
        const counts = new Map(
          rows.flatMap((row) =>
            row.typeId === null ? [] : [[row.typeId, row._count._all] as const],
          ),
        );
        // Soft-deleted types are not excluded: the documents filed under one keep it, and a shelf
        // whose label vanished would be a shelf nobody could name (docs/03 §3.3.12).
        const types = await client.documentType.findMany({
          where: { id: { in: [...counts.keys()] } },
          select: { id: true, name: true },
        });
        return rest(labelled(types, counts));
      }
      case 'person': {
        const rows = await client.documentPerson.groupBy({
          by: ['personId'],
          where: { document: where },
          _count: { _all: true },
        });
        const counts = new Map(rows.map((row) => [row.personId, row._count._all] as const));
        // Deleted names included, for the reason the type is: the link survives the deletion
        // (docs/03 §3.3.19), so the documents are still there to be looked at.
        const people = await client.person.findMany({
          where: { id: { in: [...counts.keys()] } },
          select: { id: true, name: true },
        });
        return rest(labelled(people, counts));
      }
      case 'subject': {
        const rows = await client.documentSubject.groupBy({
          by: ['subjectId'],
          where: { document: where },
          _count: { _all: true },
        });
        const counts = new Map(rows.map((row) => [row.subjectId, row._count._all] as const));
        const subjects = await client.subject.findMany({
          where: { id: { in: [...counts.keys()] } },
          select: { id: true, name: true },
        });
        return rest(labelled(subjects, counts));
      }
    }
  }

  async markUnstartedQueued(documentId: string, tx?: TransactionHandle): Promise<void> {
    // Raw, because six columns have to move on one condition each and Prisma has no way to say
    // "this column, if it is PENDING" in a single update.
    await clientOf(this.prisma, tx).$executeRaw`
      UPDATE "documents" SET
        "canonical_status"     = CASE WHEN "canonical_status"     = 'PENDING' THEN 'QUEUED'::"StepStatus" ELSE "canonical_status"     END,
        "preview_status"       = CASE WHEN "preview_status"       = 'PENDING' THEN 'QUEUED'::"StepStatus" ELSE "preview_status"       END,
        "markdown_status"      = CASE WHEN "markdown_status"      = 'PENDING' THEN 'QUEUED'::"StepStatus" ELSE "markdown_status"      END,
        "analysis_status"      = CASE WHEN "analysis_status"      = 'PENDING' THEN 'QUEUED'::"StepStatus" ELSE "analysis_status"      END,
        "fields_status"        = CASE WHEN "fields_status"        = 'PENDING' THEN 'QUEUED'::"StepStatus" ELSE "fields_status"        END,
        "vectorization_status" = CASE WHEN "vectorization_status" = 'PENDING' THEN 'QUEUED'::"StepStatus" ELSE "vectorization_status" END
      WHERE "id" = ${documentId}::uuid AND "deleted_at" IS NULL`;
  }

  async listStaleUnstartedIds(
    olderThan: Date,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<string[]> {
    const rows = await clientOf(this.prisma, tx).document.findMany({
      where: {
        deletedAt: null,
        updatedAt: { lt: olderThan },
        // Both halves of "not started". PENDING is a step nothing is scheduled for — a migration
        // reset it, and the sweep is the only thing coming. QUEUED is a step a job was made for, and
        // it is here because the job can go missing: a crash between the enqueue and the run leaves
        // a row saying a worker is on the way when none is. The handler is idempotent, so the cost of
        // sweeping one that was fine is a repeated run (docs/05 §5.4).
        OR: [
          { canonicalStatus: { in: ['PENDING', 'QUEUED'] } },
          { previewStatus: { in: ['PENDING', 'QUEUED'] } },
          { markdownStatus: { in: ['PENDING', 'QUEUED'] } },
          { analysisStatus: { in: ['PENDING', 'QUEUED'] } },
          { fieldsStatus: { in: ['PENDING', 'QUEUED'] } },
          { vectorizationStatus: { in: ['PENDING', 'QUEUED'] } },
        ],
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async listReadableItems(
    viewer: Viewer,
    ids: string[],
    tx?: TransactionHandle,
  ): Promise<DocumentListItem[]> {
    if (ids.length === 0) return [];
    const client = clientOf(this.prisma, tx);
    const rows = await client.document.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        ...readableBy(viewer, await shareReach(client, viewer)),
      },
      include: LIST_INCLUDE,
    });
    const items = await this.toItems(rows, tx);
    // In the asked order, with what the access rule refused simply absent (docs/03 §3.3.23).
    const byId = new Map(items.map((item) => [item.document.id, item] as const));
    return ids.flatMap((id) => {
      const item = byId.get(id);
      return item === undefined ? [] : [item];
    });
  }

  async listIdsByStepStatus(
    step: DocumentStep | undefined,
    status: StepStatus | undefined,
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
             analysis_status, fields_status, vectorization_status, count(*) AS count
      FROM documents
      WHERE deleted_at IS NULL
      GROUP BY 1, 2, 3, 4, 5, 6
    `;

    const counters = emptyCounters();
    for (const row of rows) {
      const count = Number(row.count);
      counters.total += count;
      add(counters, 'canonical', row.canonical_status, count);
      add(counters, 'preview', row.preview_status, count);
      add(counters, 'markdown', row.markdown_status, count);
      add(counters, 'analysis', row.analysis_status, count);
      add(counters, 'fields', row.fields_status, count);
      add(counters, 'vectorization', row.vectorization_status, count);
    }
    return counters;
  }

  async listReadable(
    viewer: Viewer,
    query: ListDocumentsInput,
    tx?: TransactionHandle,
  ): Promise<DocumentPage> {
    // 🔒 The cursor names the order it was cut from, and one that names another order is refused
    // rather than read off this column (docs/07 §7.1): a keyset predicate applied to the wrong
    // column does not fail, it answers — skipping and repeating rows while looking like a page.
    const sort = query.sort ?? DEFAULT_DOCUMENT_SORT;
    const cursor = decodeDocumentCursor(query.cursor, sort);
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
      orderBy: ORDER_BY[sort],
      take: query.limit + 1,
    });

    return {
      items: await this.toItems(rows.slice(0, query.limit), tx),
      nextCursor: nextCursorOf(sort, rows, query.limit),
    };
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
    // 🔒 The pattern is escaped, the offset counts the folder itself — see `folderPrefixPattern`.
    const below = folderPrefixPattern(folder);

    const keys = await client.$queryRaw<{ id: string; title: string }[]>`
      SELECT DISTINCT d.id, d.title
      FROM documents d
      JOIN document_files df ON df.document_id = d.id
      JOIN file_refs f ON f.file_id = df.file_id
      WHERE d.deleted_at IS NULL
        AND f.library_id = ${libraryId}::uuid
        AND (${folder} = '' OR f.path LIKE ${below} ESCAPE '\\')
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
    // A collection has one order and takes no `sort` (docs/07 §7.1), so the cursor it cuts names
    // that one — and the shared predicate below reads the column the name says, not the column this
    // method happens to have ordered by.
    const cursor = decodeDocumentCursor(query.cursor, 'createdAt');
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
      orderBy: ORDER_BY.createdAt,
      take: query.limit + 1,
    });

    return {
      items: await this.toItems(rows.slice(0, query.limit), tx),
      nextCursor: nextCursorOf('createdAt', rows, query.limit),
    };
  }

  // A whole page of rows plus what their files and their names say about them — four queries for
  // the page rather than four per row (docs/03 §3.3.10, docs/07 §7.3).
  private async toItems(rows: ListRow[], tx?: TransactionHandle): Promise<DocumentListItem[]> {
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);
    const client = clientOf(this.prisma, tx);
    const byDocument = await this.files.listForDocuments(ids, tx);
    const liveRefs = await this.files.countLiveRefsForFiles(
      [...byDocument.values()].flat().map((file) => file.id),
      tx,
    );

    // Who and what the page is about: one query each, for all of it. Both link tables have a
    // composite primary key beginning with `document_id`, so `document_id IN (…)` is index-served
    // (docs/04 §4.4) — which is what makes carrying these on every card affordable at all.
    const peopleRows = await client.documentPerson.findMany({
      where: { documentId: { in: ids } },
      select: { documentId: true, person: { select: { id: true, name: true } } },
      // Catalogue order, like the detail: a card must not shuffle its names between two renders.
      // A deleted person keeps their place — the link survives the deletion (docs/03 §3.3.19).
      orderBy: [{ documentId: 'asc' }, { person: { name: 'asc' } }],
    });
    const subjectRows = await client.documentSubject.findMany({
      where: { documentId: { in: ids } },
      select: { documentId: true, subject: { select: { id: true, name: true } } },
      orderBy: [{ documentId: 'asc' }, { subject: { name: 'asc' } }],
    });

    const people = groupNames(
      ids,
      peopleRows.map((row) => ({ documentId: row.documentId, name: row.person })),
    );
    const subjects = groupNames(
      ids,
      subjectRows.map((row) => ({ documentId: row.documentId, name: row.subject })),
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
        people: people.get(row.id) ?? [],
        subjects: subjects.get(row.id) ?? [],
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
    // The copies each page has had (docs/05 §5.6). They are in the trash and carry refs of their own
    // — a replaced library original is still lying on its volume — so they are counted and filtered
    // exactly like the files above rather than by a rule of their own.
    const versionsByFile = await this.files.listVersionsFor(fileIds, tx);
    const versions = [...versionsByFile.values()].flat();
    const liveRefs = await this.files.countLiveRefsForFiles(
      [...fileIds, ...versions.map((version) => version.id)],
      tx,
    );

    // 🔒 The file locations a viewer is shown are only those they could have reached anyway
    // (docs/07 §7.3): an admin sees every ref, everyone else only their visible libraries. The
    // availability above is counted over *all* libraries — a file is no less readable for lying in
    // one this caller cannot see.
    const refIds = [...fileIds, ...versions.map((version) => version.id)];
    const refRows =
      refIds.length === 0
        ? []
        : await client.fileRef.findMany({
            where: {
              fileId: { in: refIds },
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

    const refsByFile = new Map<string, DocumentFileRefView[]>(refIds.map((fileId) => [fileId, []]));
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
      earlierVersions: (versionsByFile.get(file.id) ?? []).flatMap((version) =>
        // A version is in the trash by construction; a row that somehow is not has no business
        // being called one, and is dropped rather than dated with a lie.
        version.trashedAt === null
          ? []
          : [
              {
                ...version,
                trashedAt: version.trashedAt,
                purgeAfter: purgeAfterOf(version, this.trashRetentionDays),
                available: readable(version, liveRefs),
                refs: refsByFile.get(version.id) ?? [],
              },
            ],
      ),
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
        kindId: link.subject.kindId,
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
    const client = clientOf(this.prisma, tx);
    // The typed-fields answer and its FTS projection land together, exactly as in updateProcessing:
    // one is derived from the other and must never drift from it (docs/03 §3.3.10a).
    if (input.extracted !== undefined) {
      await client.$executeRaw`
        UPDATE documents
           SET extracted = ${input.extracted}::jsonb,
               extracted_search_text = ${input.extractedSearchText ?? null}
         WHERE id = ${id}::uuid`;
    }
    const row = await client.document.update({
      where: { id },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.fieldsStatus === undefined ? {} : { fieldsStatus: input.fieldsStatus }),
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
        // 🔒 The instruction the next build reads (docs/05 §5.5 step 1). It was missing from this
        // list while every layer above it carried the field, so a chosen format was accepted, logged
        // and answered as the `AUTO` still in the column — the one field here whose whole purpose is
        // to be read later was the one field never written.
        ...(input.pageFormat === undefined ? {} : { pageFormat: input.pageFormat }),
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

  // One statement, and the cascades of docs/04 §4.2 take the journal, the chunks, the people and
  // subject links and the `document_files` rows with it (docs/03 §3.3.10).
  async hardDelete(id: string, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).document.deleteMany({ where: { id } });
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
// Asked of a file of a document and of an earlier version of one alike: what decides it is where the
// bytes are and how many live refs point at them, and neither of those is about a position.
function readable(file: Pick<File, 'id' | 'origin'>, liveRefs: Map<string, number>): boolean {
  return isFileReadable(file.origin, liveRefs.get(file.id) ?? 0);
}

// A DATE column grouped by day, folded into the calendar years it falls in — read in UTC, which is
// the zone the column is written and queried in (docs/07 §7.3).
function countYears(
  rows: ReadonlyArray<{ documentDate: Date | null; _count: { _all: number } }>,
): Map<number, number> {
  const years = new Map<number, number>();
  for (const row of rows) {
    if (row.documentDate === null) continue;
    const year = row.documentDate.getUTCFullYear();
    years.set(year, (years.get(year) ?? 0) + row._count._all);
  }
  return years;
}

// Counts by id, paired with the names the catalogue gives those ids. A row whose catalogue entry has
// gone missing entirely is dropped rather than shown as a blank shelf.
function labelled(
  names: ReadonlyArray<{ id: string; name: string }>,
  counts: ReadonlyMap<string, number>,
): DocumentGroupCount[] {
  return names.flatMap((row) => {
    const count = counts.get(row.id);
    return count === undefined ? [] : [{ key: row.id, label: row.name, count }];
  });
}

// A page's worth of link rows, back into a list per document and in the order they were read.
function groupNames(
  documentIds: readonly string[],
  rows: ReadonlyArray<{ documentId: string; name: DocumentName }>,
): Map<string, DocumentName[]> {
  const byDocument = new Map<string, DocumentName[]>(documentIds.map((id) => [id, []]));
  for (const row of rows) byDocument.get(row.documentId)?.push(row.name);
  return byDocument;
}
