import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectTestPrisma, testPrisma } from '../helpers/db';

// The migration that turned every row of `document_files` into pages (ADR-025, docs/04 §4.5). What
// is under test is the statement itself — read out of the migration file rather than copied, so a
// test cannot quietly drift from the SQL that ran against somebody's archive — replayed over
// fixtures of each shape a file could be in when the release landed:
//
//   a stored `page_order`      → that many entries, in that order;
//   a counted `page_count`     → its pages, as they lie;
//   nothing counted at all     → one entry with a NULL page index, standing for the file whole.
//
// It runs in a schema of its own, over its own tables, so it can be replayed after the real
// migration has already been applied to this database.

const SCHEMA = 'm55_migration_check';

// Read from the repository root, which is where the suite runs (docs/14 §14.8).
const MIGRATION = join(
  process.cwd(),
  'prisma/migrations/20260825140000_a_document_is_pages/migration.sql',
);

// The one statement between the markers: the data step, without the DDL either side of it.
function dataStep(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const from = sql.indexOf('\n', sql.indexOf('-- >>>'));
  const to = sql.indexOf('-- <<<');
  if (from < 0 || to < 0) throw new Error('the migration no longer marks its data step');
  return sql.slice(from, to).trim();
}

type Entry = {
  position: number;
  name: string;
  page_index: number | null;
  turn: unknown;
  crop: unknown;
  crop_source: string;
};

describe('A document is pages: the migration (integration)', () => {
  const prisma = testPrisma();

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
    // The shape the tables had before this migration, and the one it writes into.
    await prisma.$executeRawUnsafe(`
      CREATE TABLE ${SCHEMA}.files (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        crop JSONB,
        crop_source "ValueSource" NOT NULL DEFAULT 'NONE',
        rotation JSONB,
        page_order JSONB,
        page_rotations JSONB,
        page_count INTEGER
      )`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE ${SCHEMA}.document_files (
        document_id UUID NOT NULL,
        position INTEGER NOT NULL,
        file_id UUID NOT NULL
      )`);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE ${SCHEMA}.document_pages (
        id UUID PRIMARY KEY,
        document_id UUID NOT NULL,
        position INTEGER NOT NULL,
        file_id UUID NOT NULL,
        page_index INTEGER,
        turn JSONB,
        crop JSONB,
        crop_source "ValueSource" NOT NULL DEFAULT 'NONE'
      )`);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await disconnectTestPrisma();
  });

  const DOCUMENT = '11111111-1111-4111-8111-111111111111';

  async function givenFile(
    id: string,
    position: number,
    columns: {
      name: string;
      mimeType: string;
      crop?: string;
      cropSource?: string;
      rotation?: string;
      pageOrder?: string;
      pageRotations?: string;
      pageCount?: number;
      documentId?: string;
    },
  ): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${SCHEMA}.files
         (id, name, mime_type, crop, crop_source, rotation, page_order, page_rotations, page_count)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5::"ValueSource", $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
      id,
      columns.name,
      columns.mimeType,
      columns.crop ?? null,
      columns.cropSource ?? 'NONE',
      columns.rotation ?? null,
      columns.pageOrder ?? null,
      columns.pageRotations ?? null,
      columns.pageCount ?? null,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${SCHEMA}.document_files (document_id, position, file_id)
       VALUES ($1::uuid, $2, $3::uuid)`,
      columns.documentId ?? DOCUMENT,
      position,
      id,
    );
  }

  // The statement as the migration runs it, against the tables above.
  async function migrate(): Promise<void> {
    const statement = dataStep();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}, public`);
      await tx.$executeRawUnsafe(statement);
    });
  }

  async function pagesOf(documentId = DOCUMENT): Promise<Entry[]> {
    return prisma.$queryRawUnsafe<Entry[]>(
      `SELECT p.position, f.name, p.page_index, p.turn, p.crop, p.crop_source
         FROM ${SCHEMA}.document_pages p
         JOIN ${SCHEMA}.files f ON f.id = p.file_id
        WHERE p.document_id = $1::uuid
        ORDER BY p.position`,
      documentId,
    );
  }

  it('turns a stored page order into that many entries, in that order, with the turns they named', async () => {
    await givenFile('aaaaaaaa-1111-4111-8111-111111111111', 0, {
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      pageOrder: '[2, 0, 1]',
      pageRotations: '[0, 1, 3]',
      pageCount: 3,
    });

    await migrate();

    const pages = await pagesOf();
    expect(pages.map((page) => page.page_index)).toEqual([2, 0, 1]);
    // A page turn lands on the page it named — by the file's own index, not by where the page sits.
    expect(pages.map((page) => page.turn)).toEqual([
      { quarterTurns: 3, mirrored: false },
      null,
      { quarterTurns: 1, mirrored: false },
    ]);
    expect(pages.every((page) => page.crop === null)).toBe(true);
  });

  it('turns a counted file into its pages, as they lie', async () => {
    await givenFile('bbbbbbbb-1111-4111-8111-111111111111', 0, {
      name: 'two.pdf',
      mimeType: 'application/pdf',
      pageCount: 2,
    });

    await migrate();

    expect((await pagesOf()).map((page) => [page.position, page.page_index])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('holds a file nobody has counted as one entry standing for it whole, carrying its crop', async () => {
    await givenFile('cccccccc-1111-4111-8111-111111111111', 0, {
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      crop: '{"points": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]}',
      cropSource: 'MANUAL',
      rotation: '{"quarterTurns": 1, "mirrored": false}',
    });

    await migrate();

    const pages = await pagesOf();
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page_index).toBeNull();
    // The crop and the turn of an image land on the page it is read as — one page, since an image
    // is one page (docs/03 §3.3.17).
    expect(pages[0]?.crop).toEqual({
      points: [
        [0.1, 0.1],
        [0.9, 0.1],
        [0.9, 0.9],
        [0.1, 0.9],
      ],
    });
    expect(pages[0]?.crop_source).toBe('MANUAL');
    expect(pages[0]?.turn).toEqual({ quarterTurns: 1, mirrored: false });
  });

  it('numbers the pages of a whole document across its files, in the order it held them', async () => {
    await givenFile('dddddddd-1111-4111-8111-111111111111', 0, {
      name: 'two.pdf',
      mimeType: 'application/pdf',
      pageCount: 2,
    });
    await givenFile('eeeeeeee-1111-4111-8111-111111111111', 1, {
      name: 'letter.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await givenFile('ffffffff-1111-4111-8111-111111111111', 2, {
      name: 'ordered.pdf',
      mimeType: 'application/pdf',
      pageOrder: '[1, 0]',
      pageCount: 2,
    });

    await migrate();

    // 0-based and contiguous across the whole document, in the order its files stood in.
    expect((await pagesOf()).map((page) => [page.position, page.name, page.page_index])).toEqual([
      [0, 'two.pdf', 0],
      [1, 'two.pdf', 1],
      [2, 'letter.docx', null],
      [3, 'ordered.pdf', 1],
      [4, 'ordered.pdf', 0],
    ]);
  });

  it('reads an order that never described the file as no order at all', async () => {
    // A row written by another version, or a count that moved under it: the pages of the file as
    // they lie, exactly as the build read such an order (docs/05 §5.5 step 1).
    await givenFile('a1111111-1111-4111-8111-111111111111', 0, {
      name: 'stale.pdf',
      mimeType: 'application/pdf',
      pageOrder: '[1, 0]',
      pageCount: 3,
    });
    // And an order that is not a list of whole page numbers at all, which must not stop the release.
    await givenFile('a2222222-1111-4111-8111-111111111111', 1, {
      name: 'nonsense.pdf',
      mimeType: 'application/pdf',
      pageOrder: '["x", 1]',
      pageCount: 2,
    });

    await migrate();

    expect((await pagesOf()).map((page) => [page.name, page.page_index])).toEqual([
      ['stale.pdf', 0],
      ['stale.pdf', 1],
      ['stale.pdf', 2],
      ['nonsense.pdf', 0],
      ['nonsense.pdf', 1],
    ]);
  });

  it('leaves a crop on anything that is not an image where it was: unread', async () => {
    // Only an image was ever cropped by the build (docs/05 §5.5 step 1), so a crop on a PDF is not
    // carried onto its pages — a rebuild that suddenly cropped twenty pages would be a surprise
    // nobody asked for.
    await givenFile('a3333333-1111-4111-8111-111111111111', 0, {
      name: 'cropped.pdf',
      mimeType: 'application/pdf',
      crop: '{"points": [[0, 0], [1, 0], [1, 1], [0, 1]]}',
      cropSource: 'MANUAL',
      pageCount: 2,
    });

    await migrate();

    const pages = await pagesOf();
    expect(pages.map((page) => page.crop)).toEqual([null, null]);
    expect(pages.map((page) => page.crop_source)).toEqual(['NONE', 'NONE']);
  });
});
