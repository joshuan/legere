import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectTestPrisma, migrationPrisma } from '../helpers/db';

const SCHEMA = 'receipt_reference_migration_check';
const sql = readFileSync(
  'prisma/migrations/20261001210000_receipt_review_references/migration.sql',
  'utf8',
);
const dataStep = sql.slice(sql.indexOf('WITH dispositions AS'), sql.indexOf('-- <<<'));

describe('Receipt review reference migration', () => {
  const db = migrationPrisma();
  beforeEach(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await db.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
    await db.$executeRawUnsafe(
      `CREATE TABLE ${SCHEMA}.archive_items (id TEXT PRIMARY KEY, kind TEXT DEFAULT 'RECEIPT', created_by_id TEXT DEFAULT 'owner', deleted_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT '2026-01-01')`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE ${SCHEMA}.receipts (id TEXT PRIMARY KEY, review_state TEXT DEFAULT 'ACTIVE', review_id TEXT)`,
    );
    await db.$executeRawUnsafe(
      `CREATE TABLE ${SCHEMA}.receipt_reviews (id TEXT PRIMARY KEY, position BIGSERIAL, owner_id TEXT DEFAULT 'owner', action TEXT, first_id TEXT, second_id TEXT, result_id TEXT, undone_at TIMESTAMPTZ)`,
    );
  });
  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await disconnectTestPrisma();
  });
  it('recovers old replacements and undone merges without restoring unrelated deletions or active reused results', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}, public`);
      await tx.$executeRawUnsafe(`INSERT INTO archive_items (id, deleted_at) VALUES
        ('keep', NULL), ('duplicate', NOW()), ('restored-a', NULL), ('restored-b', NULL),
        ('undone-result', NOW()), ('reused-result', NULL), ('replaced-result', NOW()),
        ('unrelated-deletion', NOW()), ('wrong-owner', NOW()), ('converted', NOW())`);
      await tx.$executeRawUnsafe(
        `INSERT INTO receipts (id) SELECT id FROM archive_items WHERE id <> 'converted'`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE archive_items SET kind = 'DOCUMENT' WHERE id = 'converted'`,
      );
      await tx.$executeRawUnsafe(`INSERT INTO receipt_reviews (id, action, first_id, second_id, result_id, undone_at) VALUES
        ('keep-decision', 'KEEP_FIRST', 'keep', 'duplicate', 'keep', NULL),
        ('undone', 'MERGE', 'restored-a', 'restored-b', 'undone-result', NOW()),
        ('old-reuse', 'MERGE', 'restored-a', 'restored-b', 'reused-result', NOW()),
        ('old-replaced', 'MERGE', 'restored-a', 'restored-b', 'replaced-result', NOW()),
        ('new-replaced', 'KEEP_FIRST', 'keep', 'replaced-result', 'keep', NULL),
        ('converted-decision', 'KEEP_SECOND', 'converted', 'keep', 'keep', NULL),
        ('foreign', 'KEEP_SECOND', 'wrong-owner', 'keep', 'keep', NULL)`);
      await tx.$executeRawUnsafe(
        `UPDATE receipt_reviews SET owner_id = 'outsider' WHERE id = 'foreign'`,
      );
      await tx.$executeRawUnsafe(dataStep);
    });
    const rows = await db.$queryRawUnsafe<
      Array<{ id: string; review_state: string; review_id: string | null; deleted_at: Date | null }>
    >(
      `SELECT a.id, r.review_state, r.review_id, a.deleted_at FROM ${SCHEMA}.archive_items a JOIN ${SCHEMA}.receipts r ON r.id = a.id ORDER BY a.id`,
    );
    expect(rows.find((row) => row.id === 'duplicate')).toMatchObject({
      review_state: 'REPLACED',
      review_id: 'keep-decision',
      deleted_at: null,
    });
    expect(rows.find((row) => row.id === 'undone-result')).toMatchObject({
      review_state: 'MERGE_UNDONE',
      review_id: 'undone',
      deleted_at: null,
    });
    expect(rows.find((row) => row.id === 'replaced-result')).toMatchObject({
      review_state: 'REPLACED',
      review_id: 'new-replaced',
      deleted_at: null,
    });
    expect(rows.find((row) => row.id === 'reused-result')).toMatchObject({
      review_state: 'ACTIVE',
      review_id: null,
      deleted_at: null,
    });
    for (const id of ['unrelated-deletion', 'wrong-owner']) {
      expect(rows.find((row) => row.id === id)).toMatchObject({
        review_state: 'ACTIVE',
        review_id: null,
      });
      expect(rows.find((row) => row.id === id)?.deleted_at).toBeInstanceOf(Date);
    }
    expect(rows.some((row) => row.id === 'converted')).toBe(false);
  });
});
