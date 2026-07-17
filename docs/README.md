# Legere Documentation

This is the project's **source of truth**. The code implements what is written here. A divergence between
code and documentation is a bug in the code. A contradiction between documents is a bug in the
documentation — report it (see [`../CLAUDE.md`](../CLAUDE.md)).

---

## Reading order

| # | Document | About | Status |
|---|----------|-------|--------|
| 01 | [`01-vision-and-scope.md`](./01-vision-and-scope.md) | Vision, personas, glossary, MVP boundaries | ✅ written |
| 02 | [`02-architecture-overview.md`](./02-architecture-overview.md) | One process (Nest+Next), stack rationale (ADRs) | ✅ written |
| 03 | `03-domain-model.md` | Entities, relations, enums, invariants, access model | 📋 planned |
| 04 | `04-database-schema.md` | Full Prisma schema, pgvector, indexes, migrations | 📋 planned |
| 05 | [`05-library-and-processing.md`](./05-library-and-processing.md) | External library, scanning, deduplication, queue, processing pipeline | ✅ written |
| 06 | `06-backend-architecture.md` | NestJS + Clean Architecture, Next integration, queue workers | 📋 planned |
| 07 | `07-api-specification.md` | REST API: conventions and endpoints | 📋 planned |
| 08 | [`08-auth-and-authorization.md`](./08-auth-and-authorization.md) | Email+password, email verification, invites, sessions, roles | ✅ written |
| 09 | `09-file-storage.md` | Read-only library, S3 for derived artifacts, signed URLs, source streaming | 📋 planned |
| 10 | `10-frontend-architecture.md` | Next.js + FSD + next-intl + antd + TanStack Query | 📋 planned |
| 11 | `11-ui-ux-spec.md` | Screens: viewer, search, libraries, scan sets, admin panel | 📋 planned |
| 12 | `12-build-config-run.md` | Build, env, local run, deployment example | 📋 planned |
| 13 | `13-ci-cd.md` | GitHub Actions: PR checks and image publishing to GHCR | 📋 planned |
| 14 | `14-coding-standards.md` | Code and testing standards | 📋 planned |

## Implementation

The task backlog (`tasks/backlog.md`) will appear **after** the specification is complete (documents 03–14).

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
  when needed) → categorization → vectorization (embeddings in pgvector).
- **PDF tooling lives outside:** a sibling **Stirling-PDF** container (conversion to PDF, OCR, scan-set
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
