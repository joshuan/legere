# 05. External Library and the Processing Pipeline

The heart of Legere: how a read-only storage turns into processed, searchable documents.
The data model here is described conceptually; exact fields/indexes — in 03/04 (once written).

## 5.1. External libraries

- A **library** is a root path inside the mounted read-only volume (`/library/...`), configured by an
  admin in the admin panel: name, path, enabled/disabled, scan interval, exclusion rules
  (glob patterns, hidden files), user visibility ([`08 §8.5`](./08-auth-and-authorization.md)).
- There can be several libraries (different volumes or subdirectories of one volume).
- **Invariant 🔒:** the application opens library files for reading only. The volume is mounted `:ro` —
  writing is impossible even with a bug in the code. All paths are validated against the library root
  (path-traversal protection: `..` and symlinks leading outside the volume are ignored).

## 5.2. Scanning and change detection

- A scan is a queue job (`library-scan`): on cron (the library's interval, default 15 min), via the
  "Scan now" button, and once when a library is created/enabled.
- The scan is **incremental**: it walks the tree and compares `(path, size, mtimeMs)` with known
  `FileRef`s:
  - a new path not in the DB → create `FileRef(DISCOVERED)` + enqueue `file-ingest`;
  - path exists, `size`/`mtime` match → skip (content is not re-read);
  - path exists, `size`/`mtime` changed → move to `DISCOVERED`, enqueue `file-ingest` (rehash);
  - path exists in the DB but the file is gone from disk → mark `MISSING` (§5.7).
- One scan per library at a time (a pg-boss singleton job); re-triggering during a scan is a no-op.
- The scan result (found/new/changed/missing counts, duration, errors) goes to the scan journal
  (admin panel).

## 5.3. Files, documents, deduplication

A two-level model (consequence of ADR-009):

- **`FileRef`** — a physical file: `libraryId`, `path` (relative to the library root), `size`,
  `mtime`, `contentHash`, status (`DISCOVERED → HASHED → MISSING?`). A file is only a "pointer".
- **`Document`** — a logical unit of content: `contentHash` (unique), format, processing statuses,
  derived artifacts, category, Markdown, vectors. Everything user-facing (folders/collections, sharing,
  category) hangs off the document, not the file.

The `file-ingest` job computes SHA-256 of the file stream:
- the hash already exists in the DB → attach the `FileRef` to the existing `Document` (**dedup**:
  processing is not repeated);
- the hash is new → create a `Document`, enqueue `document-process`.

**Invariants:**
- One `Document` per `contentHash` (unique index).
- A document has ≥ 0 live `FileRef`s (0 — when all copies are gone, §5.7).
- Renaming/moving a file without changing its content = a `path` change on the `FileRef` (the document
  and its processing are untouched; the old path is marked MISSING, the new one is attached by hash).

## 5.4. Job queue (pg-boss)

| Job | What it does | Concurrency (default) |
|-----|--------------|-----------------------|
| `library-scan` | incremental library walk | 1 per library |
| `file-ingest` | SHA-256, attach/create document | 4 |
| `document-process` | orchestrates the §5.5 steps for a document | 2 |
| `scanset-merge` | merges a scan set (§5.6) | 1 |
| `maintenance` | cleanup of expired verifications/invites, orphaned artifacts | cron |

Rules:
- **Idempotency is mandatory:** re-running any job with the same input creates no duplicates and breaks
  no state (an "already done?" check is the first step of every handler). pg-boss guarantees
  at-least-once, not exactly-once.
- **Retries:** exponential backoff (e.g. 5 attempts); exhaustion — a `FAILED` status on the entity + an
  entry in the error journal (admin panel) with a manual "Retry".
- **Priorities:** actions explicitly requested by a user (`scanset-merge`, manual rescan) rank above
  background work.
- Per-type concurrency is env-configured; the total load is capped so the queue does not starve the API
  in the same process.
- Enqueueing a job and writing an entity happen in a single DB transaction (pg-boss lives in the same
  PostgreSQL).

## 5.5. Document processing pipeline (`document-process`)

Steps run sequentially for a document; each step records its status
(`PENDING / DONE / FAILED / SKIPPED`) — progress is visible in the admin panel. A step's failure does
not block steps independent of it (no preview — text is still extracted, and vice versa).

```
source ──► (1) PDF canonicalization ──► (2) JPG preview ──► (3) Markdown ──► (4) categorization ──► (5) vectorization
```

All derived artifacts (the canonical PDF, previews, Markdown files) are saved to the private S3 bucket
through the `FileStorage` port
([ADR-010](./02-architecture-overview.md#adr-010-derived-artifacts--s3-private-bucket-filestorage-port));
they are served to the client via short-lived signed URLs after an access check.

1. **Canonicalization to PDF** (for uniform previews and OCR):
   - PDF → no canonicalization needed (the source already is a PDF);
   - office formats (DOCX/XLSX/PPTX/ODT/…) → Stirling-PDF: conversion to PDF → a `canonical.pdf`
     artifact;
   - images → no canonicalization (preview and OCR work with the image directly);
   - plain text / Markdown → no canonicalization;
   - an unsupported format → `SKIPPED` for steps 1–3 and 5, the document remains "without a
     representation".
2. **First-page JPG preview:** PDF (source or canonical) → Stirling-PDF (PDF→IMG, first page); an
   image → `sharp` (resize/EXIF orientation/JPEG). Artifacts `preview.jpg` (+ a smaller `thumb.jpg`
   for lists).
3. **Markdown extraction:**
   - the PDF has a text layer (a meaningful-text threshold) → extract the text layer → Markdown;
   - no text layer / it is an image (a scan) → **OCR** via Stirling-PDF (tesseract, languages from
     env, default rus+eng) → text → Markdown;
   - plain text / Markdown → as is (encoding normalization).
   The Markdown is stored with the document and indexed by PostgreSQL FTS.
4. **Categorization:** classification against the managed category list (proposal: LLM via the same
   configurable API as embeddings — open question
   [`01 §1.7`](./01-vision-and-scope.md#17-open-questions)). An auto-assigned category is marked as
   auto; the user may correct it (a manual assignment is never overwritten by auto again).
5. **Vectorization:** chunking of the Markdown (by headings/paragraphs, with overlap) →
   `EmbeddingProvider` → chunk vectors into pgvector. Provider not configured → `SKIPPED` (graceful
   degradation: semantic search unavailable, everything else works).

**Search** (details — in 07): hybrid — PostgreSQL FTS over the Markdown + pgvector cosine similarity,
merged results; filters by category/library/dates.

## 5.6. Scan sets: merging into a PDF on explicit request

Scenario: a physical document scanned into dozens of JPGs with large margins (a passport ≈ 40 files).

- In the UI the user selects the image files (in page order) and triggers "Merge into PDF" — a
  `ScanSet` is created along with a `scanset-merge` job.
- `scanset-merge` pipeline: for each item, read the source image → **margin trimming** via `sharp`'s
  `trim()` (content bounding-box detection; applied when `cropMode = TRIM`, skipped for `NONE`) →
  Stirling-PDF assembles the trimmed images into a PDF (one page per image, page order = item
  positions) → the result is uploaded to S3.
- The result is a **new derived `Document`** (its source PDF lives in S3 as
  `documents/{id}/source.pdf`; it has no `FileRef` in the library; provenance is recorded via
  `scanSetId`). It goes through the regular §5.5 pipeline (preview/OCR/categorization/vectorization)
  and belongs to the user who created it ([`08 §8.5`](./08-auth-and-authorization.md)).
  Edge case: if the merged PDF's content hash matches an existing active document, that document is
  **reused** (attached as the scan set's result) instead of creating a duplicate.
- The source files are not modified and do not disappear from the library. A failed merge — a FAILED
  status on the `ScanSet` (with the error text); the user may edit the set and retry.

## 5.7. Files disappearing and returning

- A file vanished from disk → `FileRef.status = MISSING` (+`missingSince`). Document data is **not
  deleted**.
- All of a document's `FileRef`s are MISSING → the document is marked "unavailable" (visible in lists
  with a badge; preview/md/search still work — they live in S3 and the DB; downloading the source is
  unavailable).
- The file came back (same hash at the same or another path) → the link is restored, the document is
  available again.
- There is no physical cleanup of MISSING records in the MVP (only manual document deletion by an
  admin = soft delete).

## 5.8. Observability (admin panel)

- Queue state: depth per job type, active jobs, FAILED with the error text and a "Retry" button.
- Per-library scan journal (§5.2).
- Counters: documents total/processed/without representation/unavailable; artifact volume in the S3
  bucket.

## 5.9. Open questions

None. Previously open items — resolved:

1. **PDF text-layer extraction:** `pdfjs-dist` via the `TextExtractor` port; validated by an early
   spike task.
2. **OCR threshold:** a PDF goes to OCR when its average extracted text is below
   `PDF_TEXT_MIN_CHARS_PER_PAGE` (default 32) characters per page.
3. **Margin cropping:** per-image `sharp.trim()` before PDF assembly (§5.6); no crop preview in MVP.
4. **Chunking:** split on headings/paragraph boundaries targeting `CHUNK_TARGET_CHARS` (1000) with
   `CHUNK_OVERLAP_CHARS` (200) overlap.
5. **HEIC:** attempt `sharp` decode; if the runtime build lacks HEIC support, preview/markdown steps
   are `SKIPPED` for that document (documented limitation; the file remains registered and
   downloadable).
