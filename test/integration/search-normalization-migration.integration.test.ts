import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { disconnectTestPrisma, migrationPrisma } from '../helpers/db';

const SCHEMA = 'search_normalization_migration_check';
const migration = readFileSync(
  'prisma/migrations/20261019120000_search_unicode_normalization/migration.sql',
  'utf8',
);
const previous = readFileSync(
  'prisma/migrations/20260819160000_one_name_in_two_scripts/migration.sql',
  'utf8',
);
const oldFunctionStart = previous.indexOf('CREATE OR REPLACE FUNCTION search_tokens');
const oldFunction = previous.slice(oldFunctionStart, previous.indexOf('$$;', oldFunctionStart) + 3);
// The migration has one SQL function body; the remaining statements are ordinary DDL.
const functionEnd = migration.indexOf('$$;') + 3;
const statements = [
  migration.slice(0, functionEnd),
  ...migration
    .slice(functionEnd)
    .split(';')
    .filter((statement) => statement.trim() !== ''),
];

describe('Search normalization migration (integration)', () => {
  const db = migrationPrisma();

  afterAll(async () => {
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await disconnectTestPrisma();
  });

  it('rebuilds pre-existing document vectors and all name indexes without changing stored text', async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA ${SCHEMA}`);
      await tx.$executeRawUnsafe(`SET LOCAL search_path TO ${SCHEMA}, public`);
      await tx.$executeRawUnsafe(oldFunction);
      await tx.$executeRawUnsafe(`CREATE TABLE documents (
        id INTEGER PRIMARY KEY, title TEXT, extracted_search_text TEXT, description TEXT,
        markdown TEXT, country TEXT, city TEXT,
        search_vector TSVECTOR GENERATED ALWAYS AS (search_tokens(title)) STORED
      )`);
      await tx.$executeRawUnsafe(
        'CREATE INDEX documents_search_vector_idx ON documents USING GIN (search_vector)',
      );
      const decomposed = 'Расчетныи\u0306 листок июнь 2026';
      const composed = decomposed.normalize('NFC');
      await tx.$executeRawUnsafe('INSERT INTO documents (id, title) VALUES (1, $1)', decomposed);
      const nameTables = ['files', 'people', 'subjects'];
      for (const table of nameTables) {
        await tx.$executeRawUnsafe(`CREATE TABLE ${table} (name TEXT)`);
        await tx.$executeRawUnsafe(
          `CREATE INDEX ${table}_name_fts_idx ON ${table} USING GIN (search_tokens(name))`,
        );
        await tx.$executeRawUnsafe(`INSERT INTO ${table} (name) VALUES ($1)`, decomposed);
      }
      const before = await tx.$queryRawUnsafe<Array<{ found: boolean }>>(
        "SELECT search_vector @@ websearch_to_tsquery('simple', $1) AS found FROM documents",
        composed,
      );
      expect(before).toEqual([{ found: false }]);

      for (const statement of statements) await tx.$executeRawUnsafe(statement);

      // Force the expression indexes: evaluating the new function in a sequential scan would
      // pass even if the migration forgot to rebuild the old index entries.
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const documents = await tx.$queryRawUnsafe<Array<{ title: string }>>(
        "SELECT title FROM documents WHERE search_vector @@ websearch_to_tsquery('simple', $1)",
        composed,
      );
      expect(documents).toEqual([{ title: decomposed }]);
      for (const table of nameTables) {
        const names = await tx.$queryRawUnsafe<Array<{ name: string }>>(
          `SELECT name FROM ${table} WHERE search_tokens(name) @@ websearch_to_tsquery('simple', $1)`,
          composed,
        );
        expect(names).toEqual([{ name: decomposed }]);
      }
    });
  });
});
