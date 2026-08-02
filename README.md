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

Docker, and one line:

```bash
curl -fsSL https://raw.githubusercontent.com/joshuan/legere/main/deploy/init.sh | bash
```

It asks where your documents live (creating the folder if it is not there yet), writes a
`docker-compose.yaml` and a `.env` with freshly generated secrets, and offers to start. To answer up
front instead, put the setting in front of `bash` — in front of `curl` it reaches the wrong process:

```bash
curl -fsSL https://raw.githubusercontent.com/joshuan/legere/main/deploy/init.sh | LIBRARY_PATH=/mnt/documents bash
```

Prefer to read before you run — a sound habit with any `curl | bash`:

```bash
curl -fsSL https://raw.githubusercontent.com/joshuan/legere/main/deploy/init.sh -o init.sh
less init.sh && bash init.sh
```

That is the whole stack: Legere, PostgreSQL with pgvector, Stirling-PDF for the heavy PDF work, and
MinIO for the artifacts Legere produces. Migrations apply themselves on start. Open
<http://localhost:3000> and:

1. the first visit offers **onboarding**: an email, a six-digit code, a password, and you are the
   instance's first admin. Until you configure SMTP the code goes to `docker compose logs app` — that
   is enough to create the first account, and not enough to invite anyone else;
2. **Admin → Libraries → Add**: pick a folder inside the mounted volume. The first scan starts
   immediately, and every file becomes a document — deduplicated by content, so the same bytes in two
   places stay one document;
3. watch it happen in **Admin → Queue**: per-queue depth, per-step counters, and what failed;
4. **Documents** shows the grid with previews as they are produced; open one for the viewer, the
   extracted text, and its metadata;
5. **Search** finds documents by their text (title and body). Semantic search stays switched off, and
   says so, until you point `EMBEDDINGS_API_BASE_URL` at an OpenAI-compatible endpoint;
6. select a few scanned images in the grid → **Create scan set** → reorder, trim margins, merge: the
   pages become one PDF document, processed like any other.

`GET /api/health` reports the database and the queue; it is the liveness probe.

Nothing is written to the library volume, ever — it is mounted read-only. Everything Legere produces —
canonical PDFs, previews, thumbnails, merged scans — lives in the object store, and clients only reach
it through short-lived signed URLs.

Two things to know before serving it to anyone else:

- **`APP_BASE_URL` must be the address people actually type.** The CSRF check is fail-closed, so a
  mismatch rejects every login. `init.sh` asks for it; changing it later means editing `.env`.
- **Put TLS in front of anything that leaves your network.** Sessions and documents travel in the
  clear otherwise. The `sid` cookie takes its `Secure` attribute from `APP_BASE_URL`, so switching to
  `https://…` there (and in `S3_PUBLIC_ENDPOINT`) is all it takes.
- **`S3_PUBLIC_ENDPOINT` is how the browser reaches the object store**, not how the server does. A
  presigned URL is only valid for the host it was signed against, so previews stay blank if it points
  somewhere the browser cannot follow.

Pointing the `S3_*` variables at a managed object store and deleting the two MinIO services is a
supported edit; the full variable list is in
[`docs/12 §12.4`](./docs/12-build-config-run.md#124-envexample). The image is published for
`linux/amd64` and `linux/arm64`.

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
