# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

There is no code yet. The **specification is complete**: all documents 01–14 in `docs/` (the source
of truth) are written and all open questions are resolved. The next step is the task backlog
(`docs/tasks/backlog.md` — a numbered implementation plan derived from the docs); implementation
starts only after it exists. Once scaffolding starts, add the real build/lint/test commands here.

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
5. **Pull-request-based development:** direct pushes to `main` are forbidden; branch → PR → green CI →
   merge. Conventional Commits (`<type>(<scope>): <summary>`).
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
file storage is attached to the server; Legere scans it, deduplicates by SHA-256, processes documents
through a pg-boss queue (canonicalization to PDF → JPG preview → Markdown with OCR → categorization →
vectorization into pgvector), and provides a viewer, hybrid search (FTS + vectors), sharing, and an
admin panel. Heavy PDF operations (conversion, OCR, scan-set merging) run in an external
**Stirling-PDF** container. Derived artifacts live in a private **S3 bucket** (served via
short-lived signed URLs); the server stores no files locally. Details — `docs/01`, `docs/02`,
`docs/05`.
