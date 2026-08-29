// 🔒 The two mechanical proofs that `docs/04`, `prisma/schema.prisma` and the migrated database
// still describe one thing (docs/04 §4.1, §4.3, §4.5). Both were established by hand once, in
// M47.17, and a thing established by hand drifts back — SEC-81 is a schema block that stopped
// matching the file it claims to be, and SEC-82 is the diff that could not be used as a gate because
// nobody had written down what its output is allowed to be.
//
//   1. The fenced `prisma` block of §4.1 is `prisma/schema.prisma`, character for character, apart
//      from the leading comment header that file carries naming the section.
//   2. `prisma migrate diff` from the migrated database to that schema emits exactly the statements
//      §4.3 records as its known residue, and nothing else. The residue cannot be empty — the raw
//      SQL of §4.3 says things Prisma's schema language cannot — and every statement in it is one
//      that must never be run, which is why the list is written down rather than eyeballed.
//
// The allow-list is read out of §4.3 rather than repeated here on purpose: it has one home, and a
// line added to the code cannot widen what the documentation says is acceptable.
//
//   node scripts/check-schema.mjs [--docs <path>] [--schema <path>] [--database-url <url>]
//
// Without a database URL (neither the flag nor DATABASE_URL) check 2 reports itself as skipped and
// the command still fails on check 1. The test suite runs both (`test/integration`), so CI does.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DOCS_PATH = 'docs/04-database-schema.md';
const SCHEMA_PATH = 'prisma/schema.prisma';

// Where each fenced block is found in the document. Anchored on the prose that introduces it, so a
// second `prisma` or `sql` block elsewhere in the file cannot be picked up by accident — and so that
// moving the block means moving the sentence that explains it.
const SCHEMA_BLOCK = { after: '## 4.1. Prisma schema', language: 'prisma' };
const RESIDUE_BLOCK = { after: 'nothing else is acceptable', language: 'sql' };

// The fenced block that follows `after`, with the fences removed.
export function fencedBlockAfter(markdown, { after, language }) {
  const anchor = markdown.indexOf(after);
  if (anchor === -1) throw new Error(`${DOCS_PATH} no longer contains "${after}"`);

  const open = markdown.indexOf(`\n\`\`\`${language}\n`, anchor);
  if (open === -1) throw new Error(`no \`\`\`${language} block follows "${after}" in ${DOCS_PATH}`);

  const start = open + `\n\`\`\`${language}\n`.length;
  const close = markdown.indexOf('\n```', start);
  if (close === -1) throw new Error(`the \`\`\`${language} block after "${after}" is never closed`);

  return markdown.slice(start, close);
}

// The header of `schema.prisma` is the run of `//` lines at its top, which names §4.1 and is the one
// thing the two artefacts are allowed to differ by.
function withoutLeadingComments(source) {
  const lines = source.split('\n');
  let first = 0;
  while (first < lines.length && lines[first].startsWith('//')) first += 1;
  return lines.slice(first).join('\n');
}

// Check 1. The block and the file, normalised only by trimming the blank lines a fence and a header
// leave behind — every other character has to match, which is what makes the block quotable.
export function documentedSchemaProblems({ docs, schema }) {
  const documented = fencedBlockAfter(docs, SCHEMA_BLOCK).trim().split('\n');
  const actual = withoutLeadingComments(schema).trim().split('\n');

  const at = documented.findIndex((line, index) => line !== actual[index]);
  if (at === -1 && documented.length === actual.length) return [];

  const line = at === -1 ? Math.min(documented.length, actual.length) : at;
  return [
    `${DOCS_PATH} §4.1 and ${SCHEMA_PATH} differ from line ${line + 1} of the block:`,
    `  ${DOCS_PATH}: ${JSON.stringify(documented[line] ?? '(the block ends here)')}`,
    `  ${SCHEMA_PATH}: ${JSON.stringify(actual[line] ?? '(the file ends here)')}`,
    '  They are one artefact kept in two places (§4.1) — move both, in the same commit.',
  ];
}

// A `--script` diff is SQL with `-- StepName` comments between the statements. Compared as a set of
// statements rather than as text: the order Prisma emits them in is its own business, and the
// question this check asks is which statements exist.
function statementsOf(script) {
  return script
    .split(';')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((statement) => statement !== '')
    .map((statement) => `${statement};`);
}

function migrateDiff(databaseUrl, schemaPath) {
  return execFileSync(
    'node_modules/.bin/prisma',
    ['migrate', 'diff', '--from-url', databaseUrl, '--to-schema-datamodel', schemaPath, '--script'],
    { encoding: 'utf8', env: { ...process.env, CHECKPOINT_DISABLE: '1' } },
  );
}

// Check 2. Every statement outside the recorded residue is drift, and every recorded statement that
// has stopped appearing is a note about the database that is no longer true — both are answers the
// next hand-written migration needs before it is written.
export function migrateDiffProblems({ docs, script }) {
  const allowed = new Set(statementsOf(fencedBlockAfter(docs, RESIDUE_BLOCK)));
  const emitted = new Set(statementsOf(script));

  const problems = [];
  for (const statement of emitted) {
    if (!allowed.has(statement)) {
      problems.push(`drift: ${statement}  — not in the residue §4.3 records; explain it or fix it`);
    }
  }
  for (const statement of allowed) {
    if (!emitted.has(statement)) {
      problems.push(`gone: ${statement}  — §4.3 still records it; the residue has to move too`);
    }
  }
  return problems;
}

export function checkSchema({ docsPath = DOCS_PATH, schemaPath = SCHEMA_PATH, databaseUrl } = {}) {
  const docs = readFileSync(docsPath, 'utf8');
  const problems = documentedSchemaProblems({
    docs,
    schema: readFileSync(schemaPath, 'utf8'),
  });

  if (databaseUrl === undefined || databaseUrl === '') {
    return { problems, diffChecked: false };
  }
  problems.push(...migrateDiffProblems({ docs, script: migrateDiff(databaseUrl, schemaPath) }));
  return { problems, diffChecked: true };
}

function flag(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1];
}

if (process.argv[1]?.endsWith('check-schema.mjs')) {
  const { problems, diffChecked } = checkSchema({
    docsPath: flag(process.argv, 'docs', DOCS_PATH),
    schemaPath: flag(process.argv, 'schema', SCHEMA_PATH),
    databaseUrl: flag(process.argv, 'database-url', process.env.DATABASE_URL),
  });

  for (const problem of problems) console.error(`check-schema: ${problem}`);
  if (!diffChecked) {
    console.error('check-schema: no DATABASE_URL — the `prisma migrate diff` half did not run');
  }
  if (problems.length > 0) process.exit(1);
  console.log(
    diffChecked
      ? 'check-schema: docs/04 §4.1 is schema.prisma, and the migrate diff is its recorded residue'
      : 'check-schema: docs/04 §4.1 is schema.prisma',
  );
}
