# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

**The backlog M0–M31 is implemented** — there is no unchecked task in
`docs/tasks/backlog.md`, so the next piece of work starts by writing one. Every mandatory scenario of `docs/14 §14.8` is mapped to a test in
`docs/tasks/scenario-coverage.md`. The specification (documents 01–14 in `docs/`) remains the source
of truth; new work continues the same way — take the first unchecked task, tick it off in the same
commit, and where a task changes what the docs say, the doc moves first (golden rule 3).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | one process on :3000 (Express + Nest `/api` + Next) — needs `npm run dev:up` |
| `npm run dev:up` / `dev:down` | the dev dependencies in Docker: PostgreSQL+pgvector, Stirling-PDF, MinIO |
| `npm run build` | `next build`, then the server into `dist/` |
| `npm run typecheck` | `tsc --noEmit` over the app, the server and the tests — **run before every commit** |
| `npm run lint` / `lint:fix` | ESLint (layer boundaries included) + Prettier |
| `npm test` | the whole suite (unit + integration + e2e) against the dev PostgreSQL |
| `npm run test:coverage` | the same with the ≥90% line floor on `domain` + `application`; this is what CI runs |
| `npm run db:migrate` | apply migrations forward (also what the container does on start) |
| `npm run db:migrate:dev` | author a new migration from a schema change — **but see below** |
| `npm run db:seed` | idempotent dev seed: `admin@legere.local` / `password` |
| `npm run release` | cut a release (`docs/13 §13.3a`); `-- patch` / `-- major` for other bumps |

A single test file: `npx vitest run --project server <path>` (`--project web` for `src/web`). The
MinIO- and Stirling-backed integration suites skip themselves when those containers are not up.

**Migrations are written by hand, not generated.** `db:migrate:dev` reads the raw SQL of `04 §4.3`
— the generated `search_vector` column, the pgvector indexes — as drift it must "fix", and fails
with a syntax error while trying. Write `prisma/migrations/<timestamp>_<slug>/migration.sql`
yourself in the style of its neighbours, edit `schema.prisma` to match, and apply it with
`db:migrate`. If a `migrate dev` attempt has already left a failed row behind, clear it with
`npx prisma migrate resolve --rolled-back <name>` before applying anything else.

A release is `npm run release` and nothing else: it gates on the CI run that already passed for the
pushed `HEAD` — do **not** re-run the suite locally to "verify before releasing", and do not create
tags or GitHub Releases by hand (CI publishes the Release from the tag with generated notes). The
command then stays at the console until the release is actually out: it returns when
`ghcr.io/<owner>/legere:latest` resolves to the image this tag built (tens of minutes at worst). The
push is the point of no return — Ctrl-C after it loses the report, not the release.

## Golden rules

1. **English everywhere.** Everything in this repository is written in English: documentation
   (`docs/`, README), code and identifiers, comments, commit messages, branch names, pull request
   titles and descriptions, backlog tasks. The product UI is localized (ru/en via next-intl), but
   translation keys and the reference message catalog (`en.json`) are in English. Conversation with
   the user may be in any language — artifacts committed to the repository must be English only.
2. **The source of truth is `docs/`.** Code implements the documentation. Do not invent fields,
   endpoints, or behavior — describe them in docs first.
3. **A contradiction or gap in the documentation → stop and ask.** Each document collects its open
   questions in its final section — do not resolve them silently.
4. **The external library is read-only. Never** design or write code that modifies library files.
5. **Commit straight to `main`** while this instance has one author and no users: no branch, no pull
   request, green checks after the fact. Conventional Commits (`<type>(<scope>): <summary>`) either
   way. This is temporary — the moment somebody else works here or somebody depends on the deployed
   instance, it goes back to branch → PR → green CI → merge.
6. **Do not change the fixed stack without approval** (see `docs/02` ADRs): one process/port
   (Express + Nest `/api` + Next `*`), one `package.json` without workspaces, npm, Prisma + PostgreSQL
   (+pgvector), pg-boss, S3 (private bucket) for derived artifacts, Zod contracts in
   `src/shared/contracts`, Ant Design, TanStack Query, next-intl.
7. **Do not simplify auth:** email+password (Argon2id) + server-side sessions + email verification by
   code; closed registration (first admin + invites). No OAuth/JWT/passport (`docs/08`).
8. **The DB schema changes only via forward-only Prisma migrations** (auto-applied on container
   start); `prisma db push`/reset against a live instance are forbidden. **Soft delete** instead of
   physical deletion.
9. **Code style:** TypeScript `strict`; `any`, type assertions `as` (except `as const`), non-null `!`,
   and path aliases are forbidden. Layer boundaries: domain/application are framework-free; the client
   never imports `src/server/*`.
10. **No hardcoded secrets** — environment variables only.

## Key architecture (summary)

Legere is a self-hosted document management system (the Immich external-library model): a read-only
file storage is attached to the server; Legere scans it, deduplicates **files** by SHA-256, and
composes them into **documents** — a document is an ordered list of files plus one canonical PDF
built from them (`02` ADR-021). Each document runs through a pg-boss queue (canonical PDF → JPG
preview → Markdown with OCR → analysis → vectorization into pgvector), and the product provides a
viewer, hybrid search (FTS + vectors), sharing, and an admin panel. Heavy PDF operations (conversion,
OCR, page merging) run in an external
**Stirling-PDF** container. Derived artifacts live in a private **S3 bucket** (served via
short-lived signed URLs); the server stores no files locally. Details — `docs/01`, `docs/02`,
`docs/05`.
