# 22. Page OCR inspection

## Product contract

The document viewer has a **Recognition** tab. An administrator explicitly chooses pages and
Google Document AI, Yandex Vision OCR, or both. Recognition is an independent inspection layer:
it never changes document Markdown, canonical text, search, extracted fields, or pipeline statuses.
Readers with document access may inspect existing results. No cloud call happens on a GET.

The viewer displays one saved page image with original, line/word outlines, and recognized-text
overlay modes. Selecting a line or word highlights its corresponding text/geometry. Provider and
historical-result selection retain page and zoom. Text and raw/normalized JSON can be copied or
downloaded. Mobile presents text in a drawer. Errors, empty recognition, processing, and old
canonical revisions are distinct states. Retry failed pages does not repeat completed pages;
explicit reruns preserve history. Text/geometry editing and adopting OCR into search are deferred.

## Data and coordinates

Canonical builds publish an immutable S3 PDF key together with `canonicalPageIds`. Legacy rows
with no key read the old `documents/:id/canonical.pdf`; new builds never overwrite that legacy
object. OCR captures that key and page mapping. A page rendition is a persisted 300 DPI PNG
(bounded to 20 megapixels and 9 MB, reducing DPI when necessary), identified by its SHA-256.
Both providers receive identical bytes. The original library remains read-only.

An OCR run records its actor, canonical key, languages, provider settings, and requested page IDs.
Each page/provider attempt records state, attempts, timing, possible billing, image and response
keys. Images, original provider JSON and normalized JSON live in private S3 beneath the document
prefix; deleting the document removes these artifacts through existing maintenance.

Normalized JSON v1 contains full text and flat elements (block, line, word), with stable result-local
IDs, parent IDs, reading order, text, polygons normalized to the input image's top-left coordinate
system, and optional confidence. Missing confidence is null, never zero. Provider output and
transforms are retained. Google text anchors are decoded against Document.text and image
transforms are inverted before normalization. Yandex pixel polygons are normalized against the
input geometry, and their documented counterclockwise corner order is normalized to clockwise
for the text overlay. OCR language hints come from document languages, with automatic detection when
empty. No LLM rewrites recognition output. Provider confidence is not comparable accuracy.

## Application and API

`PageOcrProvider` has Google Document AI and Yandex Vision adapters. Google uses a pinned
Enterprise Document OCR processor version, service-account OAuth, regional `:process`, and inline
PNG input. Yandex uses service-account API-key authentication and `recognizeText`; models are
`page` (default), `table`, and `handwritten`. Credentials come from server environment only.

`POST /api/documents/:id/ocr-runs` accepts page IDs (all canonical pages when omitted), providers,
Yandex model, and an explicit force-rerun flag; returns the created run. An idempotency key prevents
double submission. `GET` lists recent runs and returns individual run/result details.
Document-scoped image and JSON download endpoints check document access and membership.
Provider configuration is exposed as non-secret availability metadata alongside the run list.

The `page-ocr` queue is registered in ProcessingTopology/ControlPlane. A job handles one page and
one provider. Its three-hour expiry also covers provider Retry-After holds. Identical successful image/provider/settings results are reused within the document.
Persistent result leases prevent duplicate deliveries from concurrently charging for the same
attempt. Temporary errors retry with the queue policy; authentication/input errors settle as
failed. Provider gates bound concurrency and honor Retry-After. Ambiguous network failures are
marked potentially billed. Raw responses are persisted before normalization so parser repairs do
not require another paid request. Failures remain separate from the six document pipeline steps.

## Validation and rollout

Test geometry, text anchors (including Unicode), absent confidence, provider transforms, blank
pages, error classification, retries, caching, leases, partial completion, permissions, deletion,
immutable canonical publication and backwards compatibility. Browser tests cover linked selection,
overlay modes, provider switching, stale revisions and mobile layout. Existing typecheck, lint,
coverage and CI gates apply. Migration is forward-only and enqueues no historic documents. For a legacy PDF whose stable
page map could not be backfilled, an administrator can explicitly prepare pages by rebuilding
only the canonical step; this local action neither submits cloud OCR nor re-extracts search text.

Live quality evaluation requires configured cloud accounts: use the same 30–50 representative
images for both providers, with a manually corrected subset for character/word error rates.
Compare omissions, reading order, numbers/dates, latency and billed pages before changing defaults.

References: [Google OCR](https://docs.cloud.google.com/document-ai/docs/enterprise-document-ocr),
[Google response](https://docs.cloud.google.com/document-ai/docs/reference/rest/v1/Document),
[Yandex API](https://aistudio.yandex.ru/ru/docs/vision/ocr/api-ref/TextRecognition/recognize),
[Yandex geometry](https://aistudio.yandex.ru/en/docs/vision/concepts/ocr/).

## Pilot checklist

Configure one provider first and restart the instance. Open a short document's Recognition tab,
expand New recognition, choose one service and recognize one page. Check alignment in outlines and
text-overlay modes, inspect raw JSON and compare small digits, dates and names with the original.
Enable the second provider and run both on the same page. Saved raster hashes must agree.

Before a batch comparison, collect 30–50 representative pages: clean prints, phone photographs,
skewed/rotated scans, Cyrillic/Latin mixtures, small print, tables, and handwriting if relevant.
Manually transcribe a subset. Record character/word error rates, omitted lines, reading order,
numbers/dates and provider charges. The UI's duration is total page-job elapsed time, including
local rendering and gate waits; measure HTTP latency separately for a provider benchmark.
Submission attempts are recorded immediately before the cloud request, after authentication and
gate admission. Interrupted submissions may still be billed; cached/parser-only work records none.

A future provider implements `PageOcrProvider` and joins the registry/control-plane catalogues.
It consumes the same immutable PNG, stores its untouched JSON, and normalizes to input coordinates.
Provider-specific parsing stays out of the viewer. PAGE/ALTO/hOCR export, human correction, and
promotion of a selected OCR result into the search pipeline remain separate future features.
