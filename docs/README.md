# Legere Documentation

This is the project's **source of truth**. The code implements what is written here. A divergence between
code and documentation is a bug in the code. A contradiction between documents is a bug in the
documentation — report it (see [`../CLAUDE.md`](../CLAUDE.md)).

---

## Reading order

| # | Document | About |
|---|----------|-------|
| 01 | [`01-vision-and-scope.md`](./01-vision-and-scope.md) | Vision, personas, glossary, MVP boundaries |
| 02 | [`02-architecture-overview.md`](./02-architecture-overview.md) | One process (Nest+Next), stack rationale (ADRs) |
| 03 | [`03-domain-model.md`](./03-domain-model.md) | Entities, relations, enums, invariants, access model |
| 04 | [`04-database-schema.md`](./04-database-schema.md) | Full Prisma schema, pgvector, indexes, migrations |
| 05 | [`05-library-and-processing.md`](./05-library-and-processing.md) | External library, scanning, deduplication, queue, processing pipeline |
| 06 | [`06-backend-architecture.md`](./06-backend-architecture.md) | NestJS + Clean Architecture, ports, use cases, Next integration, workers |
| 07 | [`07-api-specification.md`](./07-api-specification.md) | REST API: conventions, error codes, full endpoint catalog |
| 08 | [`08-auth-and-authorization.md`](./08-auth-and-authorization.md) | Email+password, email verification, invites, sessions, roles, access model |
| 09 | [`09-file-storage.md`](./09-file-storage.md) | Read-only library, S3 for derived artifacts, signed URLs, source streaming |
| 10 | [`10-frontend-architecture.md`](./10-frontend-architecture.md) | Next.js + FSD + next-intl + antd + TanStack Query |
| 11 | [`11-ui-ux-spec.md`](./11-ui-ux-spec.md) | Screens: viewer, browse, search, collections, document composition, admin panel |
| 12 | [`12-build-config-run.md`](./12-build-config-run.md) | Build, env, local run, Dockerfile, deployment example |
| 13 | [`13-ci-cd.md`](./13-ci-cd.md) | GitHub Actions: PR checks and image publishing to GHCR |
| 14 | [`14-coding-standards.md`](./14-coding-standards.md) | Code standards, ESLint boundaries, testing, Definition of Done |

The specification is **complete** — every document is written and all previously open questions are
resolved (each document ends with its resolution notes).

## Implementation

| Document | About |
|----------|-------|
| [`tasks/README.md`](./tasks/README.md) | How to execute tasks, the working loop, Definition of Done |
| [`tasks/backlog.md`](./tasks/backlog.md) | The numbered implementation plan, derived from these documents |

Take the first unchecked task; one task = one PR; tick it off in the same PR.

---

## Cross-cutting decisions (summary)

- **One Node process on one port:** Express(ExpressAdapter) → `/api/*` to NestJS, `*` to Next.js.
  No nginx, no separate frontend/backend containers.
- **One repository, one `package.json`, npm without workspaces**, Node 26, TypeScript 7, `strict: true`.
- **Backend:** NestJS, Clean Architecture (domain/application framework-free), Prisma, PostgreSQL
  (normalized schema + the **pgvector** extension), validation — Zod.
- **Frontend:** Next.js (App Router), React, Feature-Sliced Design, Ant Design, TanStack Query.
- **Isomorphic contracts** (Zod/enums/DTOs) — in `src/shared/contracts`, no duplication, no node-only code.
- **The external library is read-only.** Legere mounts the document storage read-only and **never**
  writes to it or modifies source files.
- **Job queue — pg-boss** on top of the same PostgreSQL, workers in the same process. No Redis.
- **Deduplication** — by SHA-256 of content: one content = one document, no matter how many files contain it.
- **Processing pipeline:** canonicalization to PDF → first-page JPG preview → Markdown extraction (OCR
  when needed) → analysis → vectorization (embeddings in pgvector).
- **PDF tooling lives outside:** a sibling **Stirling-PDF** container (conversion to PDF, OCR, page
  merging, margin cropping). The app talks to it over an internal HTTP API.
- **Derived artifacts** (previews, md, merged PDFs) — in **S3** (private bucket; viewing and downloading —
  via short-lived signed URLs). An important difference from Immich: the server keeps **no local files** —
  everything Legere produces goes to S3. Code access — only through the `FileStorage` port.
- **Authentication:** **email + password** (Argon2id) + server-side sessions (httpOnly cookie); account
  setup requires **email verification by code**; the first user becomes the administrator, afterwards —
  invite links from an admin only. No external OAuth providers.
- **Authorization:** `ADMIN`/`USER` roles; document access — via library visibility and explicit sharing
  of folders/collections (details in 03).
- **Pull-request-based development:** direct pushes to `main` are forbidden; a PR must be green
  (`typecheck` + `lint` + `test` + `build`).
- **CI/CD:** GitHub Actions; on `main`/tag a **single** Docker image is built → GHCR. Deployment is not
  described in the repository (only an example in 12).
- **DB migrations are mandatory and automatic:** forward-only Prisma migrations, applied on container
  start (`prisma migrate deploy`). `prisma db push`/reset against a live instance are forbidden.
- **Deletion:** soft delete only (`deletedAt`). A file disappearing from the library is not data
  deletion but an "unavailable" marker.
- **Code style:** no `any`, no type assertions `as` (except `as const`), no non-null `!`, no path
  aliases; Prettier is part of `npm run lint`.
- **i18n:** next-intl, locale not in the URL; UI languages — **en (default)** and **ru**.
- **IDs:** UUID v4. **Time in DB:** UTC (`timestamptz`).

## Conventions

- `UPPER_CASE` — enum values. `code` — identifiers/commands.
- "Invariant" blocks — rules the code must guarantee. 🔒 — security/access related.
- "Open question" — a decision that needs human confirmation; collected at the end of each document.
