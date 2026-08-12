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
- 🔒 **A path is checked against the filesystem, not only against the string.** The lexical guard —
  no `..`, no drive letter, no UNC prefix, and the resolved path still under the root — cannot see a
  symlink, and `lstat` declines to follow only the *last* component of a path. So a library root is
  additionally resolved with `realpath` and required to land inside the volume: with `incoming` a
  link to `/etc`, `incoming/ssl` passes every lexical test there is and would hand the walker a tree
  that is not in the library. The same check answers the admin directory picker, so such a path is
  never offered as a candidate either. The walk itself needs no equivalent — it `lstat`s every entry
  and skips anything that is not a plain file or directory, so a link is never descended.
- 🔒 **A browsed path is a name, not a pattern.** `?path=` on the browse endpoint reaches a SQL
  `LIKE` prefix, where `%` and `_` are wildcards; both are escaped, so a folder called `50%` matches
  the folder called `50%` and nothing else. Unescaped, `?path=%` answered for every path in the
  library at an offset computed from a one-character folder — not a way into anything the caller
  could not already click on, but a wrong answer, and a sequential scan of the whole table to reach
  it. Escaping rather than a `path >= x AND path < y` range on purpose: a range only means "this
  prefix" when the column orders byte-wise, and no database collation is pinned.

## 5.1a. Uploads

Not every document arrives through a library. A signed-in user can send a file from the browser
(`POST /api/documents`, [`07 §7.3`](./07-api-specification.md)); the bytes go to **S3**, never to the
library volume, which stays read-only for the whole product (ADR-004).

- The mime type is detected from the content, exactly as during ingest — the browser's `Content-Type`
  and the file name are hints, not evidence.
- The content is hashed and deduplicated by the same rule as everything else (ADR-009): identical
  bytes are one document. When the match is a document the uploader may already read, the upload
  resolves to it and nothing new is created; when it is one they may not, the upload is refused
  (`409 DOCUMENT_DUPLICATE`) rather than quietly granting access to somebody else's file. On a
  self-hosted instance this is a deliberate trade: an admin can see that a duplicate exists, and no
  library document is ever handed to a user through the back door.
- The document is created with `source = UPLOAD`, `createdById` = the uploader, the file name as its
  title, and every pipeline step `PENDING`; `document-process` is enqueued in the same transaction.
- From that point it is an ordinary document: the same five steps, the same viewer, the same search,
  the same collections and sharing. The only differences are where the bytes live and who owns it.
- `UPLOAD_MAX_BYTES` (default 100 MiB) caps a single upload; a larger body is refused with
  `413`/`VALIDATION_FAILED` before anything is stored.
- 🔒 **The body is the file, so no body parser may touch these routes** — `POST /api/documents` and
  `POST /api/documents/:id/files`, the two of them. A parser drains the stream and the handler is
  handed an empty request (`Content-Type: application/json`, or curl with no explicit type, which
  sends `application/x-www-form-urlencoded`); over a mebibyte it is body-parser's own 500 instead,
  long before `UPLOAD_MAX_BYTES` can answer 413. The exempt routes are therefore **declared in one
  place**, beside the function that reads the raw body, rather than matched at the wiring by a path
  equality that covered the first of the two and silently missed the second.

## 5.2. Scanning and change detection

- A scan is a queue job (`library-scan`): on cron (the library's interval, default 15 min), via the
  "Scan now" button, and once when a library is created/enabled.
- The scan is **incremental**: it walks the tree and compares `(path, size, mtimeMs)` with known
  `FileRef`s:
  - a new path not in the DB → create `FileRef(DISCOVERED)` + enqueue `file-ingest`;
  - path exists, `size`/`mtime` match → skip (content is not re-read);
  - path exists, `size`/`mtime` changed → move to `DISCOVERED`, enqueue `file-ingest` (rehash);
  - path exists in the DB but the file is gone from disk → mark `MISSING` (§5.7).
- **A scan gives up past `SCAN_MAX_FILES` files** (default 50 000; 0 disables the guard). A library
  pointed at a home directory or a whole disk would otherwise ingest all of it, and the first sign
  would be a machine hashing overnight. The run ends `FAILED` with a message naming the limit, no
  `file-ingest` is enqueued for that pass, and the job is **not** retried — the tree will be exactly
  as large on the next attempt, so what has to change is the library path or the setting. The
  `FileRef`s created before the stop stay `DISCOVERED` and are picked up by the next successful scan.
- One scan per library at a time (a pg-boss singleton job); re-triggering during a scan is a no-op.
- The scan result (found/new/changed/missing counts, duration, errors) goes to the scan journal
  (admin panel).

## 5.3. Files, documents, deduplication

A three-level model (ADR-009, ADR-021):

- **`FileRef`** — a path on a volume: `libraryId`, `path`, `size`, `mtime`, `contentHash`, status
  (`DISCOVERED → HASHED → MISSING?`). A ref is where bytes were seen, not the bytes.
- **`File`** — the bytes themselves, once: `contentHash` (unique among live files), `mimeType`,
  `ext`, `sizeBytes`, the name it arrived under, and — for images — the crop somebody chose. The same
  content on three volumes and in one upload is **one file with four homes**.
- **`Document`** — what a person reads: an **ordered list of files** plus one **canonical PDF** built
  from them, and everything anybody said about the whole: title, description, type, people, subjects,
  Markdown, vectors, collections.

The `file-ingest` job computes SHA-256 of the file stream and then asks two questions in order:

1. **Are these bytes already a file?** Yes → attach the `FileRef` to it (**dedup**: nothing is
   processed twice, and the file keeps the document it already belongs to). No → create the file.
2. **Does that file have a document?** No — it is new — → create a document holding exactly it and
   enqueue `document-process`. Yes → nothing else happens; the bytes turned up in one more place,
   which is a fact about paths and not about documents.

**Invariants:**
- One live `File` per `contentHash`.
- A file belongs to exactly one live document; a live document holds ≥1 file.
- Renaming or moving a file without changing its content is a `path` change on a `FileRef`: the file,
  its document and its processing are untouched.
- The scan never guesses. Every file it finds already has a home or gets one; nothing on a volume is
  left dangling, and nothing that already belongs somewhere is quietly moved.

## 5.4. Job queue (pg-boss)

| Job | What it does | Concurrency (default) |
|-----|--------------|-----------------------|
| `library-scan` | incremental library walk | 1 per library |
| `file-ingest` | SHA-256, attach/create document | 4 |
| `document-process` | orchestrates the §5.5 steps for a document | 2 |
| `maintenance` | cleanup of expired verifications/invites, orphaned artifacts | cron |

Rules:
- **Idempotency is mandatory:** re-running any job with the same input creates no duplicates and breaks
  no state (an "already done?" check is the first step of every handler). pg-boss guarantees
  at-least-once, not exactly-once.
- **Retries:** exponential backoff (e.g. 5 attempts); exhaustion — a `FAILED` status on the entity + an
  entry in the error journal (admin panel) with a manual "Retry".
- **Priorities:** actions explicitly requested by a user (a rebuild after re-cropping, a manual
  rescan) rank above background work.
- Per-type concurrency is env-configured **and admin-tunable at runtime** ([`11 §11.13`](./11-ui-ux-spec.md)):
  the env values are the defaults, a stored setting overrides them, and changing one re-registers the
  workers rather than waiting for the container to be bounced. Two knobs, not one:
  **how many jobs of a queue run at once**, and **how many independent units inside a single job**
  do — the files of one document being read and cropped into pages, say. The second is one number because those
  units are all the same shape of work.
  The batch a worker takes is run **in parallel**, which is what a concurrency of four has always
  meant; it used to be awaited one job at a time, so the setting fetched four jobs and then ran them
  in a queue of its own. The total load is capped so the queue does not starve the API in the same
  process.
- Enqueueing a job and writing an entity happen in a single DB transaction (pg-boss lives in the same
  PostgreSQL).
- **A queue can be paused.** A paused queue keeps accepting jobs and registers no worker, so work
  piles up where it can be seen and nothing is lost: it is the way to stop a misbehaving step —
  an OCR container thrashing, a model answering nonsense — without stopping the instance or
  editing env. Resuming re-registers the worker and the backlog drains. Which queues are paused is a
  stored setting like the concurrencies beside it ([`11 §11.13`](./11-ui-ux-spec.md)).
- **Nobody waits unstarted for ever.** The hourly `maintenance` sweep re-enqueues documents whose row
  nothing has written to for two hours and whose steps have not started — **`PENDING` or `QUEUED`,
  and both for a reason**: `PENDING` is a step nothing was ever scheduled for, which is what a
  migration that resets every step leaves behind and what it has no queue to write to; `QUEUED` is a
  step a job *was* made for, and it is swept too because the job can go missing — a crash between the
  enqueue and the run leaves a row claiming a worker is on the way when none is, and a claim about
  the queue that only the queue can check is a claim that has to be re-checked. The sweep marks what
  it takes as `QUEUED` there and then, so the moment a step stops being unscheduled is the moment the
  archive says so (`03 §3.3.10`). At most 200 a run, so an upgrade that rebuilds an archive spreads
  over hours instead of filling the queue in one; the handler is idempotent, so being wrong costs one
  repeated run and never a broken document.

## 5.4a. What one document may cost

🔒 Nest, Next and the queue workers share one process
([ADR-002](./02-architecture-overview.md#adr-002-one-processport-expressexpressadapter--nestjs--next)).
A step that
exhausts memory or waits for ever therefore does not fail one document — it takes the HTTP surface
with it, and the retries above then do it four more times. Every place where the *content of a
document* decides how much work happens is bounded:

| Bound | Value | What it is for |
|---|---|---|
| Pixels decoded out of one image | 80 Mpx | sharp's own limit is a ceiling on what libvips can address (~268 Mpx), not a budget. A 16383×16383 single-colour PNG is a few hundred KB — far under `UPLOAD_MAX_BYTES` — and decodes to ~805 MB of raw RGB, with the perspective warp of §5.6 allocating an output of the same order. 80 Mpx clears the worst legitimate case (an A3 sheet at 600 dpi is 69.7 Mpx) and refuses the rest |
| Bytes one step holds in memory | 256 MiB | The pipeline works on whole documents — hash it, convert it, upload it — so whatever it opens is a buffer for as long as the step runs. Deliberately above `UPLOAD_MAX_BYTES`: a file this instance accepted must still be processable |
| A library file taken in at all | the same 256 MiB, refused **before the file is opened**, on the size the scan already recorded | `SCAN_MAX_FILES` bounds how many files a scan takes in, never how large one of them is. A 5 GB PDF dropped on a read-only volume is left where it is; the refusal is a failed `file-ingest` job in the queue journal, naming the file and the bound |
| Bytes read back from one outbound call | 64 MiB for a document, a Markdown conversion or a batch of vectors; 64 KiB for a page count, a task acknowledgement or an error detail | A wedged — or hostile — sibling container answering with gigabytes. The body is read chunk by chunk and the sender is cancelled, so the refusal costs one chunk instead of the whole answer |
| Characters of Markdown the search snippet is cut from | 8000 | `documents.markdown` is unbounded text holding OCR output; `ts_headline` re-parses whatever it is given, once per row returned ([`07 §7.3`](./07-api-spec.md)). Which documents match does not change — that is `search_vector`, generated over the whole column ([`04 §4.3`](./04-database-schema.md)) — only where the snippet is cut from |

**Every outbound call carries a timeout.** Without one, undici's 300 s header timeout is the only
backstop and a slow drip defeats it outright: a container that accepts a request and then says
nothing holds a processing worker for ever, and there are only `document-process` concurrency of
them. Each budget is what the work costs on the slowest hardware this is meant to run on, and each
stays under the hour a `document-process` job has ([`06 §6.8`](./06-backend-architecture.md)):

| Call | Budget |
|---|---|
| Stirling: OCR over every page | 30 min |
| Stirling: office document → PDF, images → PDF, merge, PDF → Markdown | 5 min |
| Stirling: PDF → first-page image | 2 min |
| Stirling: page count, metadata stamp | 1 min |
| Docling: submitting the canonical PDF / one long poll / collecting the result | 5 min / 30 s / 2 min |
| The analyst reading one document | 5 min |
| One batch of embeddings | 2 min |
| The captcha check on the login path | 5 s |

The captcha is the odd one out and the reason it is in this list at all: it is not a queue job but an
HTTP request handler, so a hung verifier holds a *login*. It fails closed
([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)), timeout included.

All of these are **constants in the code, not settings**. An operator has no way to know what the
right Stirling timeout is, and an instance that needs a different one has a container to fix rather
than a knob to turn. A bound that fires is a step that fails, with its reason recorded against the
document like any other failure (§5.5) — loudly, on one document, which is the direction this is
meant to fail in.

The one bound that is *not* in the application's gift is a `statement_timeout` on the database role;
it belongs to the deployment and is written up in
[`12 §12.8`](./12-build-config-run.md#128-production-notes).

## 5.5. Document processing pipeline (`document-process`)

Steps run sequentially for a document; each step records its status
(`PENDING / DONE / FAILED / SKIPPED`) — progress is visible in the admin panel. A step's failure does
not block steps independent of it (no preview — text is still extracted, and vice versa).

```
files ──► (1) canonical PDF ──► (2) JPG preview ──► (3) Markdown ──► (4) analysis ──► (5) vectorization
            │
            └─ per file: crop (images) → to PDF → merge in order → text layer → page format → metadata
```

All derived artifacts (the canonical PDF, previews, Markdown files) are saved to the private S3 bucket
through the `FileStorage` port
([ADR-010](./02-architecture-overview.md#adr-010-derived-artifacts--s3-private-bucket-filestorage-port));
they are served to the client via short-lived signed URLs after an access check.

1. **Canonical PDF — for every document, always** (ADR-021). One artifact, `canonical.pdf`, built
   from the document's files in their order, rebuildable from them at any time. Five passes:
   1. **Each file becomes a PDF part**, `unitConcurrency` of them at a time (§5.4):
      - an image → its crop applied when it has one (a perspective transform of the stored
        quadrilateral, §5.6), then one page via Stirling `img → pdf` — **on a page the shape of the
        image**, not on a fixed sheet, and the image's shape is measured after the crop, because the
        crop is what the page will be;
      - a PDF → itself, as is; its pages are the part;
      - an office format, plain text or Markdown → Stirling `file → pdf`;
      - a format nothing can render → the file contributes no page, and the step records
        `UNSUPPORTED_FORMAT` as the reason it is incomplete rather than failing the whole document.
   2. **The parts are merged in position order** into one PDF. A single-part document skips the
      merge and keeps its part.
   3. **A text layer is ensured.** The merged PDF is measured against the same threshold step 3 uses
      (`PDF_TEXT_MIN_CHARS_PER_PAGE` over its page count); below it, Stirling OCRs the whole thing in
      the document's own languages and the **searchable** PDF becomes the canonical. This is where
      `ocrUsed` is decided, and it is why a scan is a text-selectable PDF rather than a picture of
      one. Until this release that OCR pass was run and thrown away.
   4. **The format is applied** — and only here, after the text layer exists. Which format is the
      document's own `pageFormat`: `A4`, `MATCH_SOURCE`, or `AUTO`, which reads it off the pictures
      the pages were made from. A document whose pages are all *sheet-shaped* — a ratio within 8% of
      √2, which holds the A series, a scan with a little skew and the 3:2 and 4:3 a camera produces —
      becomes A4 in the orientation those pages are already in; anything else keeps the shape it was
      photographed in, because a receipt on A4 is a stamp in the middle of an empty sheet. Mixed
      shapes count as not sheet-shaped: normalising them all would letterbox whichever disagreed. A
      document made only of PDFs and office files is left alone — those pages were laid out by
      whoever produced them.
      🔒 **The order is not an implementation detail.** Recognition happens in the shape the page was
      built in, and the format is applied to the result. A page fitted onto a sheet it does not match
      gains white margins, and a recognizer thresholds a page as a whole: the margins take over the
      histogram and the paper's own grey goes to the wrong side of it together with every letter.
      Measured on a landscape photograph of an A4 page — zero characters from the whole sheet, 649
      from the same pixels with the margins cropped away. Applied afterwards it costs nothing: the
      text layer is vector and scales with the page, which is what lets one archive be strictly A4
      *and* searchable rather than a choice between the two. Best-effort, like the stamping below: a
      document whose pages could not be resized is still the document.
   5. **Metadata is stamped**: the document's title and its creation date, best-effort — a failure
      here is logged and does not fail the step, because a PDF with the wrong `/Title` is still the
      document.
   The result is written to `documents/{id}/canonical.pdf` and its page count onto the document.
   Rebuilding is a normal operation, not a repair: any change to the composition (§5.6) enqueues it.
2. **First-page JPG preview:** the canonical PDF → Stirling-PDF (PDF→IMG, first page) → `sharp`
   (resize/JPEG). Artifacts `preview.jpg` (+ a smaller `thumb.jpg` for lists). One rule for every
   document, because by this point every document is a PDF.
3. **Markdown extraction** — the canonical PDF goes through **Docling** (ADR-018), which has a layout model:
   headings stay headings and tables stay tables, instead of being flattened into a wall of text.
   With `DOCLING_URL` empty the step falls back to Stirling's converter, which reads the text and
   loses that structure. What that fallback then tidies up — Stirling's image placeholders, and the
   Markdown tables it invents for a page whose *layout* is a table — is text derived from a PDF
   somebody uploaded, so 🔒 every pattern applied to it is linear in the length of a line: a
   megabyte-long one costs a millisecond rather than minutes of a worker pinned to a core.
   Docling can also write a caption under every picture — off by default,
   because it is slow enough to matter ([`12 §12.4`](./12-build-config-run.md)).
   - the PDF has a text layer (a meaningful-text threshold, measured over the extracted text divided
     by the page count) → that text is the Markdown;
   - the languages of the result are detected from it and stored on the document (03 §3.3.10); on a
     re-run they are what OCR is given, so a scan of a Russian page is OCR'd as Russian rather than
     as whatever the instance defaults to
   - no text layer even after step 1 tried (a scan whose OCR found nothing to read) → Docling is
     asked to OCR in the document's own languages, falling back to `OCR_LANGUAGES` (default
     `rus+eng`) while it has none;
   - a document whose canonical could not be built at all → `FAILED`, with step 1's error kept as
     the reason rather than replaced by a second, less useful one.
   The Markdown is stored with the document and indexed by PostgreSQL FTS.
A step is marked `RUNNING` when the pipeline starts it and settles to its outcome when it ends, so
a long step is visibly alive rather than indistinguishable from a queued one (03 §3.3.10).

Every `SKIPPED` step records **why** (docs/03 §3.3.10), because "skipped" alone cannot be told apart
from "broken" by the person looking at it: not needed for this format, format unsupported, provider
not configured, no document types defined, no text to embed, or a document type a person set by hand.

4. **Analysis:** one look at the document by the `DocumentAnalyst` (LLM via the same
   configurable API as embeddings — open question
   [`01 §1.7`](./01-vision-and-scope.md#17-open-questions)), which answers with a document type *and*
   with where the document is from. An auto-assigned document type is marked as auto; the user may
   correct it (a manual assignment is never overwritten by auto again). The place — `country`,
   `city` — is asked for in the same call because the excerpt is the same and one round trip is
   cheaper than two, and because it needs exactly what a model has and a detector has not: a train
   ticket that says `ŽPCG` and `PODGORICA` is Montenegrin, and nothing in its text says so. Each
   field is validated on its own, so an invented document type slug does not discard a good country. The
   step **fills blanks only**: languages the offline detector found stand — it reads what it is given
   with no cost per character, which a model does not — and a place somebody filled in by hand stays;
   clearing a field is how you ask for it to be inferred again.
   🔒 **And only when the document is short enough to be worth one look.** Past
   `ANALYST_AUTO_MAX_PAGES` (default 10) the step is `SKIPPED` with `TOO_MANY_PAGES` and nothing is
   sent: a verdict read off the first ten pages of a forty-page contract is worse than no verdict,
   because it looks like one — the document would carry a type, a title and a date nobody could tell
   were guesses. The limit is on what the pipeline does **unasked**; a person may ask for that one
   document from its own page (`07 §7.3`, `analyseInFull`), and then the whole of it goes. `0` lifts
   the limit.
   **What it is shown is the document, not the opening of it.** The whole of the extracted text, and
   the pages themselves as pictures — at most `ANALYST_MAX_PAGE_IMAGES` (default 20) of them, past
   which a document is a book rather than a paper and its text carries it. `ANALYST_EXCERPT_CHARS`
   caps the text for an instance that wants it capped; `0`, the default, does not. The pictures are
   not decoration: a scan whose recognition found nothing has no text to be analysed from at all, and
   a document is a picture before it is a string. Pages that will not render are pages the model does
   not get — the analysis still runs on the text, because a missing picture is not a reason to learn
   nothing.
   And because it has seen both, it answers **how well the text represents the document** —
   `GOOD`, `PARTIAL` or `NONE`, kept beside the rest of what the machine read (`03 §3.3.10`). This is
   the signal that was missing: recognition that returned nothing reported success, the text was
   stored empty, and the only way to find out was to open the document. With no document types defined the step still runs, because
   the place is worth the call.
   **It is shown the catalogue it is filing into**: the kinds already in use, and the things
   themselves with their notes (03 §3.3.20). After the first months an archive stops meeting new
   things — almost every document is about a flat, a car or a company already known — so the job
   stops being "read a name" and becomes "recognise which one of these". A new row is what the step
   creates when nothing matches, not what it creates by default.
   It also answers a **description** — what this is, between whom and what for, in a few hundred
   characters, so an unfamiliar document can be judged without being read. Blank-fill like the place:
   a description somebody wrote stays, and clearing it asks for a new one.
   And a **title** — what a person would write on the folder, in the document's own
   language. `IMG_20260714_113355.jpg` names a file and not a document, and a grid of those is a grid
   nobody can read. The title is applied wherever `titleSource` is not `MANUAL` and recorded in
   `autoValues.title` either way, so a name somebody typed is never overwritten and the reader still
   sees what the machine would have called it (03 §3.3.10). A title is the one field here that has no
   blank to fill — every document has a file name — which is why it is governed by who decided rather
   than by whether it is empty.
5. **Vectorization:** chunking of the Markdown (by headings/paragraphs, with overlap) →
   `EmbeddingProvider` → chunk vectors into pgvector. Provider not configured → `SKIPPED` (graceful
   degradation: semantic search unavailable, everything else works).

**Search** (details — in 07): hybrid — PostgreSQL FTS over the Markdown + pgvector cosine similarity,
merged results; filters by document type/library/dates.

## 5.6. Composing a document out of files

Scenario: a passport photographed into forty images with a phone, at an angle, on a kitchen table.
Forty files, one document — and the person who took them should be able to say so, put them in
order, straighten each one, and end up with a PDF they would print.

Every operation below changes only the **composition**: which files, in what order, cropped how.
Nothing rewrites a file, and every one of them ends by enqueueing a canonical rebuild (§5.5 step 1)
followed by the rest of the pipeline — because a document whose pages changed is a different
document to read, search and categorize.

- **Add by upload.** Files sent to an existing document are stored, deduplicated and appended in the
  order they arrive. A file that already belongs to another document is refused
  (`FILE_ALREADY_IN_DOCUMENT`) — it has a home, and moving it is `combine`, below.
- **Combine.** Several documents become one: the files of the others are appended to the target in
  the order the user chose, and the emptied documents are soft-deleted. Their titles, types, people
  and collections stay with the rows that are going away — the target keeps what it had, and the
  analysis is re-run over the whole. This is what "these two scans are one document" means, and it
  replaces the scan sets of earlier releases.
- **Split.** A file removed from a document becomes a document of its own — never nothing. The new
  document is titled after the file, inherits nothing else, and is processed from scratch. Removing
  the only file of a document is refused (`DOCUMENT_LAST_FILE`): a document is emptied by deleting
  it, not by taking its parts away one at a time.
- **Reorder.** Positions are rewritten wholesale from the order the client sends; the order is the
  page order of the canonical PDF and nothing else depends on it.
- **Crop.** An image file carries a quadrilateral in normalized coordinates (03 §3.3.16) — four
  points, not a rectangle, because a photograph taken at an angle has none. Building the canonical
  applies it as a **perspective transform**: the quad is mapped onto a rectangle whose size is
  derived from the quad's own edge lengths, so a page shot from the side comes out flat and
  rectangular. `cropSource` records who chose it, and a crop somebody dragged is never replaced by a
  machine.
- **Auto-detect corners.** On request the server finds the page in the photograph: the image is
  downscaled, converted to grayscale, differentiated (Sobel), and the dominant near-horizontal and
  near-vertical lines are found by a Hough transform; the four intersections of the two strongest
  well-separated pairs are the quad. When nothing convincing is found — a page filling the frame
  edge to edge, a photograph of nothing — the answer is the content bounding box (`sharp`'s trim
  box), which is exactly what earlier releases applied unconditionally. The result is a **proposal**:
  it lands in the editor for the person to accept or drag, and is only stored when they save.

**What a change costs.** A rebuild re-runs every step, so a re-crop of one page of a forty-page
document re-OCRs the lot. That is the honest price of one canonical artifact per document, and it
is paid in the background: the document stays readable — its old canonical, preview and text remain
until the new ones are written — and is marked processing while it happens.

## 5.6a. Noticing that files belong together

Forty scans of one passport arrive on the volume as forty documents, and the person who scanned them
should not have to find them by hand. Legere therefore **suggests** groupings and never performs
them: a suggestion is a question, and the answer is a click on Combine (§11.3).

A group is proposed when several single-file documents share all of:
- the same library folder;
- an image file each;
- names that agree — a common prefix with a numeric tail (`passport-01…passport-07`,
  `IMG_0042…IMG_0048`), whose numbers are consecutive with no more than one gap;
- modification times inside one window (`GROUPING_WINDOW_MINUTES`, default 10) — one sitting at the
  scanner.

Groups of one are not suggestions. A document a person has already touched — titled, typed, filed
into a collection — is never suggested for absorption, because a suggestion that undoes somebody's
work is worse than no suggestion. Nothing about a suggestion is stored: it is computed from what is
already known, so dismissing one is a client-side act and the list is always current.

## 5.7. Files disappearing and returning

- A file vanished from disk → `FileRef.status = MISSING` (+`missingSince`). Document data is **not
  deleted**.
- Some of a document's files are unreadable → the document is `PARTIAL`; all of them → `UNAVAILABLE`.
  Either way it stays in the lists with a badge, and its **canonical PDF, preview, text and search
  keep working** — they live in S3 and the DB. What is unavailable is exactly what is missing: the
  originals behind those files.
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

1. **PDF text-layer extraction:** ~~`pdfjs-dist`~~ — **superseded**: Stirling-PDF does all PDF
   parsing (`/convert/pdf/markdown`), so the product has one PDF engine rather than two. pdfjs
   returned text runs in content-stream order with no structure, which arrived in the viewer as an
   unbroken wall; validated by an early
   spike task.
2. **OCR threshold:** a PDF goes to OCR when its average extracted text is below
   `PDF_TEXT_MIN_CHARS_PER_PAGE` (default 32) characters per page.
3. **Margin cropping:** superseded by the per-file crop of §5.6 — a quadrilateral a person can see
   and drag, with the trim box as the fallback proposal.
4. **Chunking:** split on headings/paragraph boundaries targeting `CHUNK_TARGET_CHARS` (1000) with
   `CHUNK_OVERLAP_CHARS` (200) overlap.
5. **HEIC:** attempt `sharp` decode; if the runtime build lacks HEIC support, preview/markdown steps
   are `SKIPPED` for that document (documented limitation; the file remains registered and
   downloadable).
