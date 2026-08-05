import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  GroupingCandidateReader,
  type GroupingCandidate,
} from '../../application/documents/suggest-groupings';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Viewer } from '../../domain/repositories/document.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type CandidateRow = {
  documentId: string;
  createdAt: Date;
  libraryId: string;
  libraryName: string;
  path: string;
  mtime: Date;
  name: string;
};

// The one query behind "these look like one document" (docs/05 §5.6a). Everything the rule needs is
// asked for at once and bounded by `limit`, so suggesting costs one indexed read however large the
// library is — and everything the rule refuses to consider is refused here, in SQL, rather than by
// loading the shelf and filtering it in memory.
@Injectable()
export class PrismaGroupingCandidateReader extends GroupingCandidateReader {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listCandidates(
    viewer: Viewer,
    limit: number,
    tx?: TransactionHandle,
  ): Promise<GroupingCandidate[]> {
    const client = clientOf(this.prisma, tx);

    const rows = await client.$queryRaw<CandidateRow[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (d.id)
          d.id            AS "documentId",
          d.created_at    AS "createdAt",
          l.id            AS "libraryId",
          l.name          AS "libraryName",
          fr.path         AS "path",
          fr.mtime        AS "mtime",
          fi.name         AS "name"
        FROM documents d
        JOIN document_files df ON df.document_id = d.id
        JOIN files fi ON fi.id = df.file_id
        JOIN file_refs fr ON fr.file_id = fi.id AND fr.status = 'HASHED'
        JOIN libraries l ON l.id = fr.library_id AND l.deleted_at IS NULL
        WHERE d.deleted_at IS NULL
          AND fi.deleted_at IS NULL
          AND fi.origin = 'LIBRARY'
          -- An image each: a PDF is already a document, and nothing else is a page of a scan.
          AND fi.mime_type LIKE 'image/%'
          AND fi.mime_type <> 'image/svg+xml'
          -- Single-file documents only: a document already made of several is not looking for more.
          AND (SELECT count(*) FROM document_files df2 WHERE df2.document_id = d.id) = 1
          -- 🔒 Never a document somebody has already worked on: a suggestion that undoes somebody's
          -- work is worse than no suggestion (docs/05 §5.6a).
          AND d.title_source <> 'MANUAL'
          AND d.type_source <> 'MANUAL'
          AND NOT EXISTS (
            SELECT 1 FROM collection_items ci
            JOIN collections c ON c.id = ci.collection_id
            WHERE ci.document_id = d.id AND c.deleted_at IS NULL
          )
          AND ${visibleLibrarySql(viewer)}
        ORDER BY d.id, fr.mtime ASC
      ) AS candidates
      ORDER BY candidates."createdAt" DESC, candidates."documentId" DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      documentId: row.documentId,
      libraryId: row.libraryId,
      libraryName: row.libraryName,
      folder: folderOf(row.path),
      name: row.name,
      mtimeMs: row.mtime.getTime(),
      createdAt: row.createdAt,
    }));
  }
}

// 🔒 The access rule of docs/03 §3.4, narrowed to what a candidate can be: a document with a library
// file is readable exactly when that library is. An admin sees every library.
function visibleLibrarySql(viewer: Viewer): Prisma.Sql {
  if (viewer.role === 'ADMIN') return Prisma.sql`TRUE`;
  return Prisma.sql`(
    l.visibility = 'ALL_USERS'
    OR EXISTS (
      SELECT 1 FROM library_access la
      WHERE la.library_id = l.id AND la.user_id = ${viewer.id}::uuid
    )
  )`;
}

// The folder a path lies in, which is what "the same library folder" means: `a/b/scan-1.jpg` → `a/b`,
// a file at the root of the library → ''.
function folderOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
