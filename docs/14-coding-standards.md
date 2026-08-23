# 14. Coding Standards and Testing

## 14.1. TypeScript — strictly by the types

- `strict: true` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. `any` forbidden
  (`unknown` + narrowing). Public functions in `domain`/`application` declare explicit return types.
- **No type assertions `x as T`, no non-null `x!`.** Narrow with type guards; validate external data
  with Zod (`schema.parse()` yields typed results). The only exception is `as const`. Enforced by
  ESLint (§14.2).
- **`null` vs `undefined`:** persisted "no value" is `null` (domain types, DTO responses, Zod
  `.nullable()`); `undefined`/absent — only for optional **request** input (Zod `.optional()`).
  Mappers convert explicitly (`value ?? null`). Do not mix `?:` and `| null` on one field without
  need.
- Nest decorators only in `src/server/infrastructure` and `src/server/presentation`.
- 🔒 **A field initializer may not read a constructor parameter property.** `constructor(private readonly clock: Clock)`
  assigns in the constructor *body*, and a class field initializes before that body runs — so
  `private readonly gates = new Map(… this.clock …)` gets `undefined`, silently, in a class the
  compiler is perfectly happy with. Build what a field needs **inside the constructor, from the
  parameter**. This shipped once: every service gate took an undefined clock, and the first document
  that had to wait at one died on `clock.now()` with the whole `canonical` step around it — 318
  documents before anybody looked.
- 🔒 **The transform the tests run and the compiler that ships must agree on class fields.** They did
  not: `.swcrc` (the test and dev runner) sets `useDefineForClassFields: false`, while `tsc` at
  `target: ES2023` defaults it to `true`, so the emit that ran in CI was not the emit that ran in
  production — which is how the bug above passed 1695 green tests. The build now says `false`
  explicitly, beside the `experimentalDecorators` it belongs with, and a test asserts the two files
  still say the same thing (§14.8). A difference between them is a difference no test can catch by
  testing behaviour, so it is pinned where it can only be changed on purpose.
- No legacy/back-compat code: the app ships as one unit — when contracts change, old code is deleted,
  not kept "just in case". The only history is DB migrations.

## 14.2. ESLint (flat config `eslint.config.mjs`)

Plugins: `typescript-eslint`, `eslint-plugin-import-x`, `eslint-plugin-boundaries`,
`@eslint-react/eslint-plugin`, `eslint-plugin-react-hooks`, `@next/eslint-plugin-next`,
`eslint-config-prettier`.

Key rules:
- `@typescript-eslint/no-explicit-any: error`, `no-floating-promises: error`,
  `no-non-null-assertion: error`,
  `consistent-type-assertions: [error, { assertionStyle: 'never' }]` (point exception for `as const`
  only if the rule blocks it).
- `no-console: error` in `src/server/**` (use the injected logger), `warn` elsewhere.
- **Layer boundaries (restricted imports):**
  - in `src/server/domain/**` and `src/server/application/**`: forbid `@nestjs/*`,
    `@prisma/client`, `express`, `next`, `pg-boss`, `@aws-sdk/*`, `argon2`, `nodemailer`, `sharp`,
  - in `src/web/**` and `src/app/**`: forbid any import resolving into `src/server/**`;
  - in `src/shared/contracts/**`: forbid all runtime deps except `zod`.
- **FSD boundaries** (`eslint-plugin-boundaries`) for `src/web`: downward-only imports
  (`screens → widgets → features → entities → shared`), public API (`index.ts`) only.
- Prettier runs as part of `npm run lint` (`--check`); `lint:fix` = ESLint `--fix` + Prettier
  `--write`.

## 14.3. Prettier (`.prettierrc.json`)

`singleQuote: true`, `semi: true`, `trailingComma: all`, `printWidth: 100`, `tabWidth: 2`,
`arrowParens: always`.

## 14.4. Naming

- Files `kebab-case.ts`; React components `PascalCase.tsx`; tests next to code `*.test.ts(x)`; e2e —
  `test/e2e/*.e2e.test.ts`.
- Classes/types `PascalCase` (no `I` prefix); variables/functions `camelCase`; constants
  `UPPER_SNAKE_CASE`; enum values `UPPER_SNAKE_CASE`.
- Use cases: verb+noun (`CreateLibrary`, `HandleFileIngest`). Ports: abstract classes
  (`FileStorage`, `Clock`); implementations prefixed by tech (`S3FileStorage`, `PrismaUserRepository`,
  `SystemClock`).
- English everywhere: identifiers, comments, commit messages, PR text (CLAUDE.md rule 1).

## 14.5. Comments

Comments state non-obvious constraints and intent, not narration of the code. Keep them short, in
English, and only where the code cannot speak for itself (e.g. "registered BEFORE nestApp.init(),
see docs/06 §6.9").

## 14.6. Git & PRs

- Conventional Commits: `<type>(<scope>): <summary>`; `type` ∈
  feat/fix/docs/refactor/test/chore/ci/build; `scope` ∈ server/web/contracts/db/auth/infra/i18n/docs….
- Branches: `feat/*`, `fix/*`, `docs/*`, `chore/*`. Every commit leaves the repo green.
- PR: reference the backlog task, include the DoD checklist (§14.9); squash-merge with a Conventional
  title.

## 14.7. Zod usage rules

- One schema per shape, defined in `src/shared/contracts`, reused by server (request validation) and
  client (form + response validation). No hand-written duplicate types (`z.infer` only).
- Server-only validation (env config, job payloads) lives next to its consumer in
  `src/server/**` — not in shared contracts.
- Never `parse` inside domain logic — validation happens at boundaries (HTTP pipe, job adapter,
  config), domain receives typed values.

## 14.8. Testing

Runner — **Vitest** for everything; server tests transpile via **`unplugin-swc`** (decorator
metadata — ADR-017); two Vitest projects: `server` (`environment: node`) and `web`
(`environment: jsdom`, `@testing-library/react`). E2E API — Nest app over the shared Express +
**supertest**.

| Level | Scope | How |
|-------|-------|-----|
| Unit (domain) | value objects (`RelativePath` traversal cases!), entity state machines (FileRef), access predicates (03 §3.4), chunking, hybrid-merge (RRF), the crop geometry (homography, edge detection) | pure, no I/O |
| Unit (application) | every use case and job handler with in-memory ports/repositories | orchestration, idempotency, error codes |
| Integration (infrastructure) | Prisma repositories against test Postgres (pgvector); `FsLibraryReader` against tmp fixtures; `S3FileStorage` against MinIO (local; optional in CI) | truncate between tests |
| E2E (HTTP) | full flows with mocked `FileStorage`/`PdfToolbox`/`EmailSender`/`CaptchaVerifier`/AI ports + real DB | supertest |

**Mandatory scenarios (acceptance floor):**
- Auth: onboarding only once (race → one admin); 3-step registration happy path + wrong code ×5 burn;
  invite accept/expiry/revoke; login timing-equal `INVALID_CREDENTIALS`; session fixation (new sid on
  login); logout revocation; CSRF fail-closed (mutation without Origin → 403); per-email rate caps;
  password reset revokes sessions; `LAST_ADMIN` on all three paths (role change, deactivate, delete).
- Library & scan: create validates path (outside root, file-not-dir, nested library → errors); scan
  discovers nested files, applies excludeGlobs, skips symlinks (fixture with a symlink escaping the
  root!); rescan with no changes = zero jobs; size/mtime change → rehash; rename detection (MISSING +
  re-attach by hash); missing → unavailable → return restores.
- Dedup: two paths, one content → one Document, two FileRefs, pipeline ran once.
- Pipeline: per-format step matrix (pdf-with-text no OCR; scanned pdf → OCR; office → canonical;
  image → trim/preview; txt/md passthrough; unsupported → SKIPPED); step failure isolates
  (preview FAILED but markdown DONE); reprocess subset only re-runs requested steps; vectorization
  SKIPPED without provider and `semanticAvailable=false` in search.
- Jobs: handler idempotency (double delivery of every job type), singleton scan per library,
  enqueue-in-transaction rollback (entity rollback → no job).
- Access: USER vs RESTRICTED library (list/detail/files → 403/404); ALL_USERS visible; DERIVED
  visibility via collection share (user-specific and instance-wide); share grants no LIBRARY-doc
  access; collection item filtering per viewer; admin sees everything.
- Search: FTS finds title & body; access filtering inside search; hybrid = text when no provider;
  RRF merge ordering deterministic; a number typed in either alphabet finds the paper it is printed
  on, in both directions, while a Russian word stays unreachable by its Latin look-alike; a word is
  found whether or not the paper kept its diacritics, both ways round, with the highlight landing
  when the paper spells it as it was asked for; a name and a city are found in either script, both
  ways round, while Cyrillic words under four letters are never read out into Latin (04 §4.3).
- Typed fields (03 §3.3.10a, 05 §5.5 step 5): a schema-typed document extracts, per-field validation
  drops a bad date and keeps a good vendor; a `MANUAL` value survives a re-run; a manual type change
  re-extracts under the new schema, replacing the old reading; no schema → `SKIPPED NO_SCHEMA`, no
  provider → `NOT_CONFIGURED`; FTS finds a document by an extracted value; PATCH `fields` validates
  against the schema and `reset: ['fields.<key>']` restores the read value as `AUTO`.
- Document links (03 §3.3.23): create/list/unlink round-trip on both ends; duplicate → `LINK_EXISTS`,
  self → `LINK_SELF`; an edge whose other side the caller cannot read is absent from the list;
  hard-deleting a document takes its edges; suggestions are deterministic (a document citing
  another's number proposes it), exclude self and the already-linked, and store nothing.
- Catalogue merge suggestions (03 §3.3.19, 05 §5.6c): admin-only on both endpoints; the analyst's
  groups are validated, not trusted (an id outside the living catalogue, a group of one, a row
  claimed twice → dropped; counts and lengths capped); computed on request, stored nowhere, and the
  cache answers the same catalogue without a second model call while a changed catalogue asks anew;
  no configured analyst → `configured: false` and an empty answer, never an error; 🔒 names and
  notes reach the model inside the fenced data channel, never the system message; the merge dialog's
  prefill never exceeds what the merge contract accepts, normalized or raw.
- Files and documents: a canonical PDF is built for every document whatever it is made of; adding,
  reordering, cropping and splitting each rebuild it; splitting off a file yields a document of its
  own and refuses to empty the last one (`DOCUMENT_LAST_FILE`); combining moves files in the chosen
  order and soft-deletes the emptied documents; a file belongs to exactly one document
  (`FILE_ALREADY_IN_DOCUMENT`); the crop is a quadrilateral applied as a perspective transform and a
  `MANUAL` one survives a rebuild; a document with a missing original still serves its canonical.
- API: unknown `/api/*` → JSON `NOT_FOUND` (not HTML); envelope shape on success and error; BigInt as
  string; soft-deleted → 404 everywhere.

Each scenario above is mapped to the test that proves it in
[`tasks/scenario-coverage.md`](./tasks/scenario-coverage.md); renaming or deleting one of those tests
means updating that table in the same commit.

**Coverage:** domain + application ≥ 90% lines (thresholds in `vitest.config` for those directories);
no global vanity threshold. `npm run test:coverage` enforces it, and CI runs that instead of
`npm test`. UI: unit for `shared/lib` + component tests for forms/wizards with msw.

## 14.9. Definition of Done

- [ ] Implements the docs exactly (acceptance criteria of the backlog task).
- [ ] Tests at the right level added/updated and green locally.
- [ ] `npm run typecheck && npm run lint && npm run test` green.
- [ ] Boundaries intact (Clean Architecture, FSD, client/server, contracts-only sharing).
- [ ] No secrets / `any` / `as` / `!` / `console` / raw UI strings / legacy shims.
- [ ] Schema changes ship with a forward-only migration (committed) — [`04 §4.5`](./04-database-schema.md#45-migration-policy).
- [ ] Backlog task checked off in the same PR; Conventional Commit title.

## 14.10. Open questions

None.
