# 01. Vision & Scope

## 1.1. Vision

**Legere** is a self-hosted document management system. Its operating principle is borrowed from how
**Immich** works with external libraries: Legere is deployed on a server with a **read-only document
file storage** attached. The system monitors that storage, processes the files it finds, and gives
users convenient access: viewing, search (full-text and semantic), document types, sharing.

The key idea: **source files are untouchable**. Legere never writes to the external library — everything
it produces (Markdown representations, previews, merged PDFs, metadata) lives in the database and in its
own **S3 storage** (an important difference from Immich: Legere stores its own files not on the local
disk but in a private S3 bucket — the server is stateless with respect to files). The library can be
detached, moved, or rescanned — user data is never lost in the process.

## 1.2. Primary scenario

1. An administrator deploys Legere (one Docker image + PostgreSQL + Stirling-PDF + an S3 bucket) and
   mounts a read-only volume with documents (family archive, scans, contracts, invoices, manuals…).
2. Legere scans the library: discovers files, deduplicates by content, enqueues processing jobs.
3. The queue processes the files (volumes can be large — thousands of files at once): first-page
   preview, text extraction to Markdown, analysis, vectorization.
4. Users open the web UI: browse documents with previews, read them in the viewer, search by content
   and by meaning, organize documents, and share folders/collections with each other.
5. A special case — **scan sets**: a batch of JPG scans of one physical document (for example, ~40
   files of passport scans with large margins). On the user's explicit request Legere merges them into
   a single PDF with margins cropped (via Stirling-PDF) and stores the result as a derived document.

## 1.3. Personas

| Persona | Role | What they do |
|---------|------|--------------|
| **Administrator** | `ADMIN` | Deploys the service; configures external libraries and their visibility; invites users; manages roles; monitors the processing queue and errors in the admin panel |
| **User** | `USER` | Views documents available to them; searches; organizes (folders/collections, document types); shares; triggers scan-set merging |

One person can hold both roles (the typical home scenario: the admin is also the primary user).

## 1.4. Glossary

| Term | Meaning |
|------|---------|
| **External library** (Library) | An admin-configured root path inside the read-only storage that Legere monitors. There can be several libraries |
| **File** (FileRef) | A concrete file on disk inside a library: path, size, mtime, content hash. Read-only |
| **Document** | A logical unit of content after deduplication: one content hash = one document, which several files in different locations may point to |
| **Derived artifact** (Artifact) | Something Legere produced itself: a JPG preview, a Markdown representation, a canonical PDF, a merged scan-set PDF. Stored in the app's private S3 bucket, not in the library |
| **Scan set** | A user-selected set of scan images of one physical document, merged into a single PDF with margins cropped |
| **Job** | A unit of work in the processing queue: library scan, hashing, parsing, preview, analysis, vectorization, scan-set merge |
| **Document type** | A document type from a managed reference list (passport, contract, invoice, manual…); assigned automatically, editable manually |
| **Stirling-PDF** | An external self-hosted PDF tooling service (sibling container): conversion to PDF, OCR, merge, crop |

## 1.5. MVP boundaries (scope)

**In scope:**

- Multiple external read-only libraries; periodic scanning; detection of new/changed/missing files.
- Processing queue (pg-boss) with retries, priorities, and observability (statuses in the admin panel).
- Content-based deduplication (SHA-256).
- Pipeline: canonicalization to PDF → first-page JPG preview → Markdown extraction (with OCR for
  scans) → analysis → vectorization.
- Document viewer: previews in lists, viewing the source (streamed from the library) and the Markdown
  representation.
- Search: full-text (PostgreSQL FTS over Markdown) + semantic (pgvector), hybrid results.
- Multi-user system: ADMIN/USER roles, library visibility, sharing of folders/collections.
- In-house authentication: email + password, email verification by code, server-side sessions, admin
  invites.
- Scan sets: manual file selection → merge into a PDF with margin cropping (Stirling-PDF) → a derived
  document.
- Admin panel: libraries, users/invites, document type reference list, queue and error monitoring.

**MVP file formats:** PDF, images (JPG/PNG/TIFF/WebP/HEIC), office documents (DOCX/XLSX/PPTX,
ODT/ODS/ODP), plain text/Markdown. Other formats are registered as documents "without a representation"
(visible in lists, downloadable, no preview/md/content search).

## 1.6. What we do NOT do in the MVP (non-goals)

- **Writing to the external library** — never (not just in the MVP): no renames, no moves, no edits.
- Editing document content (Legere is a system for reading and organizing, not an editor).
- User file uploads via the web (content enters only through the external library). The only exception —
  derived artifacts produced by the system itself (scan-set merging).
- Mobile apps, desktop clients (web only).
- Automatic scan-set merging (explicit user request only).
- Document versioning, content-change audit log.
- Public external links (sharing only between users of the instance).
- Quotas, billing, multi-tenancy (one instance = one team/family).

## 1.7. Open questions

None. Previously open items — resolved:

- **UI languages:** **en (default)** and **ru**
  ([ADR-016](./02-architecture-overview.md#adr-016-i18n--next-intl-locale-not-in-the-url)).
- **Embedding provider:** a configurable OpenAI-compatible HTTP API; no bundled default — when
  unconfigured, vectorization is `SKIPPED` and semantic search is unavailable (graceful degradation,
  [`12 §12.4`](./12-build-config-run.md#124-envexample)).
- **Analysis:** LLM classification against the managed document type list via the same configurable
  API; manual override always wins; seeded default document types —
  [`03 §3.3.12`](./03-domain-model.md#3312-document type).
- **OCR languages:** `OCR_LANGUAGES=rus+eng` by default, env-configurable.
- **PDF parsing (layout → Markdown):** Docling, with Stirling-PDF as the fallback when it is not deployed (ADR-018)
  ([`06 §6.3.3`](./06-backend-architecture.md#633-application-ports-non-repository)); an early spike
  task validates it.
