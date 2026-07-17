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

## Documentation

The service specification lives in [`docs/`](./docs/) (**the source of truth** — the code implements
it). Start with [`docs/README.md`](./docs/README.md) — the documentation map and cross-cutting
decisions. Repository rules for AI agents — [`CLAUDE.md`](./CLAUDE.md).
