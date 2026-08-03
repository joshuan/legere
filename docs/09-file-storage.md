# 09. File Storage

Two distinct storages with opposite rules:

| Storage | Access | Contents |
|---------|--------|----------|
| **Library volume** (`LIBRARY_ROOT`, mounted `:ro`) | read-only, streamed through the app | source files (any nesting) |
| **S3 bucket** (private) | read/write via `FileStorage` port | everything Legere produces |

## 9.1. Library volume

- Mounted into the container at `LIBRARY_ROOT` (default `/library`) with the `:ro` Docker flag —
  writes are impossible at the kernel level regardless of application bugs.
- All access goes through the `LibraryReader` port (`FsLibraryReader`):
  - every path is joined as `LIBRARY_ROOT + library.rootPath + relativePath` and then verified with
    `path.resolve` to still be inside the library root (🔒 traversal guard);
  - entries are inspected with `lstat`; **symlinks are skipped entirely** (🔒 no links following out
    of the volume); block/char devices, sockets, FIFOs are skipped;
  - hidden files/dirs (`.` prefix) are skipped by default; additional exclusions come from
    `library.excludeGlobs` (matched with `picomatch` against the library-relative path);
  - the walker (`walk`) is an async iterator yielding `{ relPath, size, mtimeMs }`, depth-first,
    sorted by name for deterministic scans; unreadable directories are recorded as scan errors and
    skipped, they do not abort the scan.
- Source download (`GET /api/documents/:id/source` for LIBRARY documents) picks the first `HASHED`
  FileRef in a library visible to the caller and streams it with backpressure
  (`Content-Length` = FileRef.size, `Content-Type` = document.mimeType,
  `Content-Disposition: attachment; filename="<title>.<ext>"` RFC 5987-encoded). If the file vanished
  between check and open (`ENOENT`) → mark the ref `MISSING`, respond `409 DOCUMENT_UNAVAILABLE`.
- Range requests are **not** supported in MVP (the in-app viewers use the canonical PDF from S3,
  where presigned URLs support ranges natively).

## 9.2. S3 bucket

- S3-compatible storage, AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
  `@aws-sdk/lib-storage` for the multipart `Upload` helper below), custom
  `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE=true` for MinIO. The bucket is **private**; no public ACLs; no
  bucket policies granting anonymous read.
- **Key layout (deterministic, no DB columns):**

```
documents/{documentId}/canonical.pdf   # canonicalized PDF (office → PDF); absent when source is PDF/text/image
documents/{documentId}/preview.jpg     # first page, max dimension 1600 px, quality 80
documents/{documentId}/thumb.jpg       # first page, max dimension 400 px, quality 75
documents/{documentId}/source.{ext}    # DERIVED and UPLOAD: the document's own bytes — a merged scan-set PDF, or the file a user sent
```

- Existence of an object ≡ the corresponding step status is `DONE` — the DB status is authoritative;
  the `maintenance` job may verify consistency but artifacts are always rewritten idempotently
  (`put` overwrites).
- **Writes** always go app → S3 (`FileStorage.put`) with `Content-Type` set; multipart upload for
  bodies > 8 MiB (SDK `Upload` helper). No client-side uploads, no POST policies.
- **Reads by clients** use presigned GET URLs, TTL `SIGNED_URL_TTL_SEC` (default 300 s), issued only
  by endpoints that already passed the document access check; the API responds `302 Location:
  <signed url>` so `<img src>`/`<embed>` work naturally with cookies on the same origin.
- The host is part of what gets signed, so when the bucket answers on a different name outside the
  server's network — a bundled MinIO is `http://minio:9000` inside a compose network and
  `http://localhost:9000` from the browser — `S3_PUBLIC_ENDPOINT` names the outside one and only
  presigning uses it. Empty (the default) means there is one endpoint for both.
- **Reads by the pipeline** (e.g. OCR needs `canonical.pdf`) go through the SDK directly (streaming
  `GetObject`), not through presigned URLs.
- Deletion policy: artifacts of soft-deleted documents are **retained** (soft delete is reversible);
  nothing in MVP hard-deletes S3 objects except `maintenance` removing orphans (objects whose
  `documentId` does not exist at all — possible only after failed half-writes).

## 9.3. `FileStorage` port (normative)

```ts
abstract class FileStorage {
  abstract put(key: string, body: Readable | Buffer, contentType: string): Promise<void>;
  abstract getStream(key: string): Promise<Readable>;            // pipeline-internal reads
  abstract getSignedUrl(key: string, ttlSec: number): Promise<string>;
  abstract exists(key: string): Promise<boolean>;
  abstract delete(key: string): Promise<void>;                   // maintenance only
  abstract list(prefix: string): Promise<{ key: string; size: number }[]>;  // maintenance only
}
```

Implementations: `S3FileStorage` (prod/dev), `InMemoryFileStorage` (unit/e2e tests). Integration
tests for `S3FileStorage` run against MinIO locally ([`14 §14.8`](./14-coding-standards.md#148-testing)).

## 9.4. Local development

`docker compose` (repo root) provides MinIO: console on `:9001`, API on `:9000`, plus a one-shot
`createbuckets` container (`mc mb --ignore-existing local/legere`). `.env.example` points
`S3_ENDPOINT=http://localhost:9000`, bucket `legere`, credentials `legere`/`legere-secret`
([`12 §12.4`](./12-build-config-run.md#124-envexample)).

## 9.5. Operational notes

- Backup = PostgreSQL dump + S3 bucket sync. The library volume is the user's own data, outside
  Legere's responsibility.
- Bucket size and object counts surface in the admin panel (via `ListObjectsV2` aggregation cached
  hourly by `maintenance` in process memory — one process serves the instance, so the cache needs no
  store of its own; it reads `null` until the first run rather than pretending the bucket is empty).
  The same listing feeds the orphan sweep above, so housekeeping costs one full listing per hour.
- S3 outage: uploads fail → jobs retry with backoff; signed-URL issuance fails → viewer shows the
  error state; the API and library streaming keep working.

## 9.6. Open questions

None.
