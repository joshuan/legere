import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  archiveDocumentSchema,
  type ArchiveDocumentsQuery,
} from '../../../shared/contracts/archive-integration';
import { PersonalArchiveRepository } from '../../domain/repositories/personal-archive.repository';
import { UnprocessableError, ValidationFailedError } from '../../domain/errors/domain-error';
import { PrismaService } from './prisma.service';

const rowSchema = archiveDocumentSchema
  .omit({ processing: true, url: true })
  .extend({ canonicalStorageKey: z.string().nullable() });
const cursorSchema = z
  .object({
    version: z.literal(1),
    context: z.string().regex(/^[a-f0-9]{64}$/),
    at: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

function eligible(subject: string) {
  return Prisma.sql`a.kind = 'DOCUMENT' AND a.created_by_id = ${subject}::uuid
    AND a.integration_id IS NULL AND a.deleted_at IS NULL AND d.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM document_pages p JOIN files f ON f.id = p.file_id
      WHERE p.document_id = d.id AND f.origin = 'LIBRARY'
    )`;
}
// Preserve PostgreSQL timestamp precision in both the DTO and keyset cursor. Converting the
// boundary through a JavaScript Date would skip documents created within the same millisecond.
const SELECT = Prisma.sql`SELECT d.id, d.title, d.description, d.canonical_storage_key AS "canonicalStorageKey",
  to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
  to_char(d.document_date, 'YYYY-MM-DD') AS "documentDate", d.page_count AS "pageCount",
  CASE WHEN t.id IS NULL THEN NULL ELSE jsonb_build_object('id', t.id, 'slug', t.slug, 'name', t.name) END AS "documentType",
  jsonb_build_object('canonical', d.canonical_status, 'preview', d.preview_status,
    'markdown', d.markdown_status, 'analysis', d.analysis_status, 'fields', d.fields_status,
    'vectorization', d.vectorization_status) AS steps
  FROM documents d JOIN archive_items a ON a.id = d.id
  LEFT JOIN document_types t ON t.id = d.type_id`;

@Injectable()
export class PrismaPersonalArchiveRepository extends PersonalArchiveRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async find(subject: string, id: string) {
    const rows = z.array(rowSchema).parse(
      await this.prisma.$queryRaw`
      ${SELECT} WHERE ${eligible(subject)} AND d.id = ${id}::uuid LIMIT 1
    `,
    );
    return rows[0] ?? null;
  }

  async list(subject: string, query: ArchiveDocumentsQuery) {
    const q = query.q.trim();
    const context = createHash('sha256')
      .update(JSON.stringify([subject, q.toLowerCase(), 'createdAt:desc,id:desc']))
      .digest('hex');
    let boundary = Prisma.empty;
    if (query.cursor !== undefined) {
      let decoded: unknown;
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error('Invalid encoding');
        decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new ValidationFailedError(null);
      }
      const parsed = cursorSchema.safeParse(decoded);
      if (!parsed.success) throw new ValidationFailedError(null);
      const cursor = parsed.data;
      if (cursor.context !== context)
        throw new UnprocessableError(
          'CURSOR_SORT_MISMATCH',
          'Cursor belongs to a different archive query',
        );
      boundary = Prisma.sql`AND (a.created_at, a.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`;
    }
    const rows = z.array(rowSchema).parse(
      await this.prisma.$queryRaw`
      ${SELECT} WHERE ${eligible(subject)} ${boundary}
      AND (strpos(lower(d.title), lower(${q})) > 0 OR strpos(lower(coalesce(d.description, '')), lower(${q})) > 0)
      ORDER BY a.created_at DESC, a.id DESC LIMIT ${query.limit + 1}
    `,
    );
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({ version: 1, context, at: last.createdAt, id: last.id }),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  }
}
