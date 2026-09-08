# 15. Receipts

Receipts are a product surface beside documents, not a document type with a shorter pipeline. They
share storage identity, ownership and audit with documents through an archive item, while keeping a
different representation and a different processing lifecycle.

## 15.1. Product boundary

- A receipt enters Legere only through the explicit receipt upload surface. Library scanning always
  creates documents; it never guesses that a file is a receipt.
- A receipt has exactly one `MANAGED` original file. Images and PDFs are accepted; office, text,
  SVG and unknown formats are refused before storage.
- A PDF may have several pages. Every page is rendered to a JPEG for viewing and extraction, while
  the original PDF stays unchanged in S3.
- A receipt has two processing steps: `preview`, then `extraction`. It has no canonical PDF,
  Markdown, OCR text, analysis, full-text search, vectors, collections, links, people or subjects.
- Extracted data is read-only in Legere. Normalisation and correction belong to a future external
  consumer and are not part of this milestone.

## 15.2. Archive item and profiles

`ArchiveItem` owns the identity common to product kinds:

| Field | Type | Notes |
|---|---|---|
| id | uuid | Stable across a kind conversion |
| kind | `DOCUMENT \| RECEIPT` | Exactly one matching profile exists |
| createdById | uuid? | Required for receipts; null remains valid for library documents |
| createdAt / updatedAt / lastEventAt / deletedAt | | Shared lifecycle and journal order |

`Document` remains the existing document aggregate and becomes the `DOCUMENT` profile of an archive
item. Document-only metadata and relationships remain on that profile.

`Receipt` is the `RECEIPT` profile:

| Field | Type | Notes |
|---|---|---|
| id | uuid | PK/FK to `ArchiveItem.id` |
| fileId | uuid | Unique; one managed original |
| pageCount | int? | One for an image, all pages for a PDF; null before preview |
| previewStatus | `StepStatus` | Durable receipt preview state |
| extractionStatus | `StepStatus` | Durable structured-reading state |
| extracted | json? | `ReceiptExtraction`, below |
| sourceText | text? | Optional noisy caller text; an extraction hint, never indexed |
| processingError / failedStep / skipReasons | | Same operational meaning as documents; skip reasons are reserved for receipt-specific gates |

The one-to-one profile keys plus the conversion repository keep every living archive item on one
profile matching `kind`. The database additionally refuses a receipt without an owner or without a
managed file carrying an S3 key. Direct document inserts remain compatible during the migration by
creating and synchronising their archive identity in triggers.

Existing `DocumentEvent` rows now reference `ArchiveItem`; the compatibility-oriented repository,
property and table names remain unchanged. Existing events keep their ids and payloads, and the
event type set gains `KIND_CHANGED`.

## 15.3. Receipt data

The current receipt field schema is version 3. Its values are vendor, the particular store's
one-line address, ISO country and city, statement descriptor, purchase date and time, total, tax,
payment method, masked card, vendor tax id, receipt number and the line-item table. Every item may
carry its printed tax code, the rate unambiguously associated with that code and a line tax amount
where the receipt actually states one; the extractor does not apportion a receipt-wide tax total.

```ts
type ReceiptExtraction = {
  schema: { slug: 'receipt'; version: number };
  values: Record<string, unknown>;
  confidence: number | null;
};
```

Every value is sanitised against the named schema before storage. Historical schema versions stay
renderable. Reprocessing replaces the complete answer with the newest schema version. No source map
or manual value is stored because the answer is not editable here.

List responses carry the extraction so the client can project its compact summary (`vendor`,
`purchasedAt`, `purchasedTime`, `total`) without another request. Detail contains the same complete
JSON plus the optional source text.

## 15.4. Upload and deduplication

Multipart `POST /api/receipts` accepts one `file` and an optional arbitrary `text` field, then uses
the same size, MIME detection, hash and S3-before-transaction rules as document upload. The text may
be a noisy HTML/plain-text email body. A new file is stored at `files/{fileId}/original.{ext}` and
then one transaction creates the File, ArchiveItem, Receipt, journal entries and `receipt-process`
job.

Deduplication remains instance-wide at File:

- an accessible existing receipt is a successful duplicate response;
- content already used by a document is `409 CONTENT_EXISTS_AS_DOCUMENT` and is never converted by
  upload;
- an inaccessible match is a generic conflict and discloses no id;
- File creation/attachment is serialised so concurrent document and receipt uploads cannot give the
  same file two product homes.

## 15.5. Artifacts and delivery

```
receipts/{receiptId}/thumb.jpg
receipts/{receiptId}/pages/{page}.jpg
```

A detected non-SVG image original may be shown inline through an access-checked signed URL. This is
the only exception to the general rule that uploaded originals are attachments. A derived JPEG is
also produced for every accepted image; every PDF page is viewed through its derived JPEG.
`/download` signs the unchanged original as an attachment.

The receipt prefix is deleted after receipt deletion or conversion. Failure after the database
commit leaves only an orphan, which maintenance removes. Maintenance treats the existence of the
matching product profile, not merely the archive item, as ownership of a product artifact prefix.

## 15.6. Processing

`receipt-process` runs sequentially and idempotently:

1. **Preview:** count pages, render every PDF page or image to a display JPEG and write the
   first-page thumbnail. The viewer uses the unchanged original for an image and the derived pages
   for a PDF.
2. **Extraction:** show every page and optional caller-supplied `sourceText` to the OpenAI-compatible
   receipt extractor, validate the answer against the current receipt schema and replace
   `Receipt.extracted` atomically. Legere never generates this text itself. An unconfigured
   classifier is `SKIPPED/NOT_CONFIGURED` and never prevents viewing.

The processing topology contains a dedicated `receipt-process` queue and a receipt worker separate
from the document step graph. Both product workers share the current outbound service gates. Receipt
preview uses Stirling for PDFs; receipt extraction uses the classifier gate. Docling, transcription
and embeddings are never receipt consumers.

## 15.7. Access, conversion and deletion

A receipt is readable by its creator and by administrators. Other callers receive 404. Safe GETs
remain reachable by the existing read-only API token as its owner; uploads, reprocessing,
conversion and deletion require a session. Receipts are not shareable in this version.

`PATCH /api/archive-items/:id/kind` changes the product profile without changing the archive item
id. The caller must be the creator or an administrator, and the source pipeline must be settled.

Document to receipt additionally requires exactly one distinct managed File with an S3 original,
and no other live item may read it. Library originals are never copied into S3 by conversion.
Receipt extraction is queued from the retained original. Document-only rows and artifacts are
removed.

Receipt to document keeps the File, discards receipt data/artifacts, creates ordinary document pages
and queues the complete document pipeline. The new document starts untyped with its file name as
title. A `KIND_CHANGED` event records either conversion.

Deleting a receipt is allowed to its creator and administrators. Its file enters the common trash
with the former kind and owner recorded; restoring it creates a receipt again and queues both receipt
steps. Only administrators operate the shared trash, as before.

## 15.8. API

| Method and path | Meaning |
|---|---|
| `POST /api/receipts` | Upload one image/PDF receipt |
| `GET /api/receipts` | Cursor page, newest added first |
| `GET /api/receipts/:id` | Receipt detail |
| `GET /api/receipts/:id/thumbnail` | First-page list thumbnail URL |
| `GET /api/receipts/:id/pages/:page` | Derived page JPEG URL; zero-based page index |
| `GET /api/receipts/:id/original` | Inline-capable original URL for the viewer |
| `GET /api/receipts/:id/download` | Unchanged original attachment URL |
| `DELETE /api/receipts/:id` | Creator/admin; file goes to trash |
| `PATCH /api/archive-items/:id/kind` | Creator/admin kind conversion |

The list does not search or sort inside receipt JSON. Its only order is `(createdAt DESC, id DESC)`.

## 15.9. UI

`Receipts` is a top-level item after `Documents`. `/receipts` uses compact desktop rows and mobile
cards: thumbnail, vendor-or-filename, purchase date/time, total, processing state and upload date.
It owns a receipt-only image/PDF picker and reports the active upload on the action itself.

`/receipts/:id` shows the original/page images on the left and read-only structured values on the
right, followed by the items table, collapsed raw JSON and source-text blocks, Copy/Download,
original file metadata, both processing steps, Move to Documents and Delete.

The whole `/receipts` screen is also a drop target. Dropping one or several images/PDFs, or choosing
several through its picker, uploads each file as a separate receipt through the same endpoint. A
full-screen receipt-specific overlay acknowledges the drag before the files are released.

A document whose type slug is `receipt` shows Move to Receipts. A library, multi-file or processing
document keeps the disabled action and a reason beside it; a shared managed file is refused by the
conversion boundary. Existing receipt documents are not migrated automatically.

## 15.10. Non-goals

- Automatic document/receipt classification.
- Receipt libraries or copying a library original into S3.
- Search, vectors, Markdown, OCR text, canonical PDFs, collections or sharing for receipts.
- Editing or normalising receipt values in Legere.
- Write-capable API tokens, app-to-app upload, webhooks, external ids or callbacks.

## 15.11. Open questions

None.
