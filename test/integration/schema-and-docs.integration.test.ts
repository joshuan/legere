import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// 🔒 The guard SEC-81 asked for, exercised (docs/04 §4.1, §4.3, §4.5). `scripts/check-schema.mjs`
// holds both mechanical proofs that the documentation, `schema.prisma` and the migrated database
// describe one thing; this suite is what makes CI run them, and — the half a guard usually lacks —
// what proves the guard fails when the thing it guards is wrong.
//
// A subprocess rather than an import: the script is what an operator runs by hand from `docs/04
// §4.5`, so its exit code is part of what is being tested.
describe('the schema, its documentation and the database (integration)', () => {
  const DOCS = 'docs/04-database-schema.md';

  // Both streams: the verdict is on stdout and every problem is on stderr, and a test that read one
  // of them would pass on a script that had stopped saying anything on the other.
  function check(args: readonly string[] = []): { status: number; output: string } {
    const run = spawnSync('node', ['scripts/check-schema.mjs', ...args], { encoding: 'utf8' });
    return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
  }

  // A copy of the document with one edit, so the guard can be shown to have teeth without the
  // repository having to be wrong for a moment.
  function docsWith(replace: string, by: string): string {
    const original = readFileSync(DOCS, 'utf8');
    expect(original).toContain(replace);
    const path = join(mkdtempSync(join(tmpdir(), 'legere-schema-')), 'docs-04.md');
    writeFileSync(path, original.replace(replace, by));
    return path;
  }

  it('passes on this repository, both halves of it', () => {
    const { status, output } = check();

    expect(output).toContain('the migrate diff is its recorded residue');
    // If DATABASE_URL were missing the block half would still pass, and this test would be
    // asserting half of what it says it asserts.
    expect(output).not.toContain('did not run');
    expect(status).toBe(0);
  });

  // SEC-81 itself: three lines of §4.1 stopped being valid Prisma during a rename and nothing
  // noticed for a milestone, because the block is prose to everything that reads this repository.
  it('fails when the documented schema stops being the schema', () => {
    const tampered = docsWith(
      'model DocumentPage {',
      'model DocumentPage { // an edit nobody made to schema.prisma',
    );

    const { status, output } = check(['--docs', tampered]);

    expect(status).toBe(1);
    expect(output).toContain('§4.1');
    expect(output).toContain('differ from line');
  });

  // SEC-82: the residue is the whole point of the diff check. A line that leaves the allow-list is
  // drift; a line that stays in it after the database has stopped emitting it is a note about the
  // database that is no longer true, and the next hand-written migration reads both.
  it('fails when the migrate diff stops being the residue §4.3 records', () => {
    const tampered = docsWith(
      'DROP INDEX "documents_search_vector_idx";',
      'DROP INDEX "a_line_no_database_emits";',
    );

    const { status, output } = check(['--docs', tampered]);

    expect(status).toBe(1);
    // Both directions, from the one edit: the GIN index the database really does propose dropping
    // is no longer covered, and the line put there in its place is never emitted.
    expect(output).toContain('drift: DROP INDEX "documents_search_vector_idx";');
    expect(output).toContain('gone: DROP INDEX "a_line_no_database_emits";');
  });

  it('says so rather than passing quietly when it cannot reach a database', () => {
    const { status, output } = check(['--database-url', '']);

    // The block half still ran and still passed; the silence is named, not implied.
    expect(status).toBe(0);
    expect(output).toContain('did not run');
  });
});
