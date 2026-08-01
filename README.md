# Legere

Legere is a document management system. Its principle is based on how Immich works with an external
library. The primary scenario: Legere is deployed on a server with a read-only storage of document
files attached; the system monitors and manages those documents.

Principles:
1) The external library is read-only.
2) There is a processing job queue for files, to handle fairly large volumes of data arriving at once.
3) File deduplication.
4) Parsing files into Markdown, categorization, and vectorization of documents.
5) A convenient document viewer (and a JPG preview of the first page of any document).

Technical:
- Node.js 26 + TypeScript 7,
- normalized PostgreSQL,
- in-house authentication with an email confirmation code,
- files produced by the system (previews, Markdown, merged PDFs) are stored in S3 (a private bucket),
  not on the local disk.

Additionally:
- a multi-user system with roles and the ability to make sets of documents/folders shared;
- a special mode for working with scan sets: for example, a scanned passport yields ~40 JPG files with
  large margins — on explicit request the system must merge them into a PDF and crop the margins;
- the PDF tooling must live outside the app, most likely a separate Stirling-PDF instance;
- an administration panel for the service itself, for admins.

---

## Quickstart

You need Docker, an S3-compatible bucket and a folder of documents. The app is one container: it
applies its own migrations on start and serves both the API and the UI on one port.

```bash
docker run -d --name legere -p 3000:80 \
  -v /mnt/documents:/library:ro \
  -e APP_BASE_URL=http://localhost:3000 \
  -e DATABASE_URL='postgresql://legere:legere@db:5432/legere?schema=public' \
  -e AUTH_SECRET='a-random-string-of-at-least-32-characters' \
  -e LIBRARY_ROOT=/library \
  -e STIRLING_URL=http://stirling:8080 \
  -e S3_ENDPOINT=http://minio:9000 -e S3_BUCKET=legere -e S3_REGION=us-east-1 \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... -e S3_FORCE_PATH_STYLE=true \
  ghcr.io/joshuan/legere:latest
```

It needs three neighbours on the same network: **PostgreSQL 16 with pgvector**
(`pgvector/pgvector:pg16`), **Stirling-PDF** (`stirlingtools/stirling-pdf`, started with
`SECURITY_ENABLELOGIN=false` — 2.x demands a login otherwise and answers 401 to every call), and an
**S3-compatible store** (MinIO does). A complete compose file is in
[`docs/12 §12.7`](./docs/12-build-config-run.md#127-deployment-example-illustration--keep-outside-the-repository);
every variable the app reads is listed in [`docs/12 §12.4`](./docs/12-build-config-run.md#124-envexample).

Then, in the browser:

1. open the site — the first visit offers **onboarding**: an email, a six-digit code, a password, and
   you are the instance's first admin. With no `SMTP_HOST` set, the code is printed to the container
   log (`docker logs legere`), which is enough to get started but not to invite anyone else;
2. **Admin → Libraries → Add**: pick a folder inside the mounted volume. The first scan starts
   immediately, and every file becomes a document — deduplicated by content, so the same bytes in two
   places stay one document;
3. watch it happen in **Admin → Queue**: per-queue depth, per-step counters, and what failed;
4. **Documents** shows the grid with previews as they are produced; open one for the viewer, the
   extracted text, and its metadata;
5. **Search** finds documents by their text (title and body). Semantic search stays switched off, and
   says so, until an embeddings provider is configured;
6. select a few scanned images in the grid → **Create scan set** → reorder, trim margins, merge: the
   pages become one PDF document, processed like any other. The originals are untouched — the library
   volume is only ever read.

`GET /api/health` reports the database and the queue; it is the liveness probe.

Nothing is written to the library volume, ever. Everything Legere produces — canonical PDFs,
previews, thumbnails, merged scans — lives in the S3 bucket, and clients only reach it through
short-lived signed URLs.

## Local development

```bash
nvm use && npm install
cp .env.example .env
mkdir -p dev-library && cp -r <some documents> dev-library/
npm run dev:up          # PostgreSQL + Stirling-PDF + MinIO (bucket included)
npm run db:migrate      # forward-only, same command the container runs on start
npm run db:seed         # admin@legere.local / password, and a library over dev-library/
npm run dev             # http://localhost:3000
```

| Command | What it does |
|---|---|
| `npm run dev` | one process on :3000 — Express + Nest `/api` + Next for everything else |
| `npm run build` | `next build`, then the server to `dist/` |
| `npm run typecheck` | `tsc --noEmit` over the app, the server and the tests |
| `npm run lint` | ESLint (layer boundaries included) + Prettier check; `npm run lint:fix` writes |
| `npm test` | the whole suite — unit, integration and e2e (needs `npm run dev:up`) |
| `npm run test:coverage` | the same, with the ≥90% floor on `domain` + `application` that CI enforces |
| `npm run db:migrate` | apply migrations forward (what the container does on start) |
| `npm run db:migrate:dev` | author a *new* migration from a schema change |

Integration suites that need MinIO or Stirling skip themselves when those are not running, so
`npm test` works with just PostgreSQL up.

## Documentation

The service specification lives in [`docs/`](./docs/) (**the source of truth** — the code implements
it). Start with [`docs/README.md`](./docs/README.md) — the documentation map and cross-cutting
decisions. Repository rules for AI agents — [`CLAUDE.md`](./CLAUDE.md).
