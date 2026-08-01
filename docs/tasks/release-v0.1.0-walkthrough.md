# v0.1.0 — fresh-instance walkthrough

The acceptance of M9.3 asks for a walkthrough of a fresh instance **against the built image**, not
against `npm run dev`. This is what was run and what came back. Nothing here is a test fixture: it is
one `docker build`, one container, a folder of files, and HTTP.

## The instance

- image `legere:v0.1.0`, built from this commit's tree with the repository `Dockerfile`;
- a database created empty (`legere_release3` on the compose PostgreSQL) — the container applied its
  own migrations on start, as `docs/12 §12.6` says it does;
- an empty bucket (`legere-release3` on the compose MinIO);
- Stirling-PDF from the compose file;
- `NODE_ENV=production`, no `SMTP_HOST`, no AI providers configured;
- the library volume mounted read-only: 8 files, 5 in `contracts/` (2 PDF, 2 Markdown, 1 RTF) and 3
  in `scans/` (JPEG).

## What happened

**Boot.** Migrations applied, five queue workers started (`library-scan`, `file-ingest`,
`document-process`, `scanset-merge`, `maintenance`), `GET /api/health` →
`{"status":"ok","db":"ok","queue":"ok"}`.

**Onboarding.** `GET /api/auth/onboarding` → `{"required":true}`. The three steps
(`register/start` → `register/verify` → `register/complete`) produced the first ADMIN and a session
cookie; afterwards `onboarding` reported `{"required":false}`. With no SMTP configured the six-digit
code arrived in the container log, as documented.

**Library.** `GET /api/admin/library-path-candidates` listed `contracts` and `scans` — the picker
sees only what is under the volume. Creating a library at the volume root returned it as
`ALL_USERS`, and the first scan started on its own.

**Scan.** The journal recorded one run, `DONE` in 130 ms: `filesSeen: 8, filesNew: 8, filesChanged:
0, filesMissing: 0`.

**Pipeline.** 8 files became 8 documents, and the queue overview settled at:

| step | outcome |
|---|---|
| canonical | DONE 1 (the RTF), SKIPPED 7 |
| preview | DONE 6, SKIPPED 2 (the two Markdown files) |
| markdown | DONE 8 |
| categorization | SKIPPED 8 (no classifier configured) |
| vectorization | SKIPPED 8 (no embeddings provider configured) |

Exactly the format matrix of `docs/05 §5.5`: PDFs need no canonicalization, the RTF was converted and
previewed from its canonical PDF, images previewed directly, text passed through, and the two AI
steps skipped themselves without failing anything.

The bucket held 13 objects afterwards — `preview.jpg` + `thumb.jpg` per previewable document, plus
the one `canonical.pdf`.

**Documents and files.** `GET /api/documents` listed all 8 with sizes, availability and preview
flags. For the contract: the preview endpoint answered `302` to a presigned MinIO URL carrying
`X-Amz-Expires=300`; `/source` streamed `Content-Type: application/pdf`, `Content-Length: 1002`,
`Content-Disposition: attachment; filename="contract.pdf"` — and the bytes were `cmp`-identical to
the file on the volume; `/markdown` returned the extracted text.

**Search.** `GET /api/search?q=schedule` returned two documents — the Markdown agreement and the
**second page** of the contract PDF — each with the term wrapped in `<mark>`, and
`semanticAvailable: false`, which is the honest answer for an instance with no embeddings provider.

**Scan set.** Two of the scans were made into a set with `cropMode: TRIM`, merged, and the set went
`DRAFT → QUEUED → DONE` with a `resultDocumentId`. The result is a `DERIVED` document, 2 pages,
93 305 bytes, carrying its `scanSetId`, processed like any other document (preview and markdown
DONE). `pdfjs` reads it as two A4 pages. The three source JPEGs on the volume were untouched.

**Access.** An invited USER saw the 8 documents of the `ALL_USERS` library and `404` for the admin's
derived scan-set document — derived documents stay with their creator until shared.

**Maintenance.** The hourly cron fired twice while the instance was up. The first run, seconds after
boot, measured an empty bucket — and the overview said so rather than showing nothing. The second,
after everything above had been processed, cached
`{"objects": 16, "bytes": "271418", "measuredAt": "2026-08-01T18:00:32.445Z"}`, which is exactly what
`mc ls -r` and `mc du` report for the bucket (16 objects, 265 KiB). Nothing was swept: every object
belongs to a document that exists.

## The CI job list, on linux

The same reasoning applies to the build that will publish the image: `npm ci`, `db:generate`,
`db:migrate`, `typecheck`, `lint`, `test:coverage`, `build` were run inside `node:26.5.1` against the
compose PostgreSQL, as an ordinary user. Everything passes — 630 tests, 97.98% of lines on
domain+application, and the Next/server build — but only after the two fixes below.

## Things this turned up

Three defects, all fixed before the tag, none of them visible to `npm test` on a developer's
machine:

1. **`npm ci` could not run on linux** — the lock file was missing `@emnapi/*` versions pinned by two
   wasm32-wasi optional bindings. macOS never resolves those, so it passed locally while CI and every
   image build failed. Fixed by regenerating the lock inside `node:26-alpine`.
2. **A malformed path id answered 500** (or `400 INTERNAL` where Nest's `ParseUUIDPipe` was used)
   instead of the 404 `docs/07 §7.1` requires. Found by mistyping a URL. Fixed with a `UuidParam`
   pipe across every `:id` route, plus per-resource e2e assertions.
3. **Eight component tests failed under coverage on a slower machine** — Vitest's 5 s default is a
   dev-laptop assumption, and M9.2 had just pointed CI at `npm run test:coverage`. The default is now
   20 s per project; the tests that wait on purpose keep their own longer timeouts. Two integration
   tests that `chmod 000` a directory also fail as root, who ignores permission bits, and now skip
   with a reason instead.

Two notes for whoever deploys it, neither a defect:

- the session cookie is `Secure` in production, so a plain-HTTP host cannot log in through a browser;
  TLS at the ingress is mandatory (`docs/12 §12.8` says so, and this is what it feels like);
- presigned URLs are signed against the S3 endpoint the server knows. Clients must reach the bucket
  under that same name — rewriting the host invalidates the signature.
