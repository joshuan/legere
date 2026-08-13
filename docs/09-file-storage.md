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
- Reading one original (`GET /api/documents/:id/files/:fileId/content`, `07 §7.3`) picks the first
  `HASHED` FileRef in a library visible to the caller and streams it with backpressure
  (`Content-Length` = FileRef.size, `Content-Disposition: attachment; filename="<file name>"`
  RFC 5987-encoded, `X-Content-Type-Options: nosniff`, and `Content-Type` by the rule in §9.2 below —
  the file's own type only when that is one a browser may safely render). If the file vanished
  between check and open (`ENOENT`) → mark the ref `MISSING`, respond `409 DOCUMENT_UNAVAILABLE`.
- Range requests are **not** supported in MVP (the in-app viewers use the canonical PDF from S3,
  where presigned URLs support ranges natively).

## 9.2. S3 bucket

- S3-compatible storage, AWS SDK v3 (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`,
  `@aws-sdk/lib-storage` for the multipart `Upload` helper below), custom
  `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE=true` for MinIO. The bucket is **private**; no public ACLs; no
  bucket policies granting anonymous read.
- **Key layout.** Document artifacts are deterministic from the document id; a managed file's key is
  **stored on the file** (`File.storageKey`, 03 §3.3.16) rather than derived, so a key written by an
  older version keeps resolving after the layout changes and no object ever has to be moved:

```
documents/{documentId}/canonical.pdf   # always — every document is a PDF (05 §5.5)
documents/{documentId}/preview.jpg     # first page of the canonical
documents/{documentId}/thumb.jpg       # the same, smaller, for lists
files/{fileId}/original.{ext}          # a managed file's own bytes: an upload, or something we made
```

- A `LIBRARY` file has no object at all: its bytes stay on the volume and are streamed from there.
  The canonical PDF is the one copy Legere keeps of a library document's content, which is why the
  document keeps reading after the volume is unplugged (05 §5.7).
- **The key is part of the answer to "where is this file".** `DocumentFileDto.storageKey`
  (`07 §7.3`) carries it, and the viewer prints it beside the file, naming the object storage as
  such, in the same place a library file names its volume and path (`11 §11.5a`). A `LIBRARY` file's
  is null, per the line above. 🔒 **A location, not a way in.** The key grants nothing: the bucket is
  private, has no public ACL and no anonymous-read policy, and the only way to read an object is a
  presigned URL issued by an endpoint that has already passed the document access check. It also
  discloses nothing the caller was not already holding — the layout is `files/{fileId}/original.{ext}`
  and both halves are on the same DTO. So it is rendered as text and never as a link: a location that
  looks clickable is a promise the bucket will not keep.
- Existence of an object ≡ the corresponding step status is `DONE` — the DB status is authoritative;
  the `maintenance` job may verify consistency but artifacts are always rewritten idempotently
  (`put` overwrites).
- **Writes** always go app → S3 (`FileStorage.put`) with `Content-Type` set; multipart upload for
  bodies > 8 MiB (SDK `Upload` helper). No client-side uploads, no POST policies.
- **Reads by clients** use presigned GET URLs, TTL `SIGNED_URL_TTL_SEC` (default 300 s), issued only
  by endpoints that already passed the document access check; the API responds `302 Location:
  <signed url>` so `<img src>`/`<object data>` work naturally with cookies on the same origin.

### 🔒 What a browser is told the bytes are

Below the magic-byte line, the MIME of a file is its own **name's** claim about it (`06 §6.3.3`), so
`report.html` is `text/html` because it is called that. That claim decides how a document is
converted and what its row displays; it never decides what a browser is told, or the bucket would
serve a page with a script in it from an origin the operator owns. One rule, applied at both ends of
an object's life:

- **Render allow-list.** `application/pdf`, `image/jpeg`, `image/png`, `image/gif`, `image/webp` — no
  more. Everything else is `application/octet-stream`. The list holds exactly what has to render: the
  canonical PDF the viewer embeds, the preview and thumbnail, and the pictures the crop editor points
  an `<img>` at. The detected MIME stays on `File.mimeType` (`03 §3.3.16`) — format classification,
  `isImageFile` and the UI read the row and never the object.
- **Stored** (`upload`/`compose` → `put`): an object is written under its allow-listed type or under
  `application/octet-stream`.
- **Served** (`getSignedUrl`): every presign sets `ResponseContentType` and
  `ResponseContentDisposition` on the `GetObjectCommand` from the `Delivery` its caller passed, so the
  bucket answers on those terms whatever the object was stored as — which covers objects written
  before this rule existed. Both overrides are part of what is signed: editing either out of the URL
  invalidates the signature, and the request is refused rather than served on softer terms.
- **Who gets `inline`:** the artifacts Legere builds itself — `canonical.pdf`, `preview.jpg`,
  `thumb.jpg`. **Everything a person uploaded is `attachment`**, named as it arrived, whether it is
  streamed from the volume or fetched from the bucket. A browser renders an attachment as nothing at
  all, whatever its type claims.
- The redirect responses carry `Content-Disposition` and `X-Content-Type-Options: nosniff` too. They
  are courtesy — the browser leaves for the bucket without them — but no file-serving response of
  Legere's is silent about how its bytes are meant to be treated.
- The host is part of what gets signed, so when the bucket answers on a different name outside the
  server's network — a bundled MinIO is `http://minio:9000` inside a compose network and
  `http://localhost:9000` from the browser — `S3_PUBLIC_ENDPOINT` names the outside one and only
  presigning uses it. Empty (the default) means there is one endpoint for both.
- **Reads by the pipeline** (e.g. OCR needs `canonical.pdf`) go through the SDK directly (streaming
  `GetObject`), not through presigned URLs.
- Deletion policy: artifacts of **soft-deleted** documents are retained — that delete is reversible,
  and a library soft-deleted or a document absorbed into another one both keep everything. What is
  removed for real is what an admin deleted for real: `DELETE /api/documents/:id` is a hard delete
  (`03 §3.3.10`), and it takes the document's own artifacts and the originals of its `MANAGED` files
  with it. The rows are deleted first and the objects afterwards, so the failure mode is an orphaned
  object rather than a row pointing at bytes that are gone.
- `maintenance` collects those orphans, and now under both layouts: an object under
  `documents/{id}/` whose document does not exist at all, and an object under `files/{fileId}/` whose
  file does not exist at all. The second half is what makes a failed delete self-healing instead of a
  slow leak — it was `documents/` only, from when nothing ever deleted a file row. Anything outside
  the two layouts is still left alone rather than guessed about.

## 9.3. `FileStorage` port (normative)

```ts
// How the bytes are meant to reach a browser. `attachment` carries the name a saved file gets;
// `inline` needs none, because nothing is being saved.
type Delivery =
  | { disposition: 'inline'; contentType: string }
  | { disposition: 'attachment'; contentType: string; fileName: string };

abstract class FileStorage {
  abstract put(key: string, body: Readable | Buffer, contentType: string): Promise<void>;
  abstract getStream(key: string): Promise<Readable>;            // pipeline-internal reads
  // The delivery is not advice: the implementation binds it into the URL (§9.2).
  abstract getSignedUrl(key: string, ttlSec: number, delivery: Delivery): Promise<string>;
  abstract exists(key: string): Promise<boolean>;
  abstract delete(key: string): Promise<void>;                   // maintenance only
  abstract list(prefix: string): Promise<{ key: string; size: number }[]>;  // maintenance only
}
```

`Delivery` is also what the API's own responses are written from, so the two ways bytes leave Legere
— streamed through the app, or fetched from the bucket by the browser — state the same thing and
cannot drift apart.

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
