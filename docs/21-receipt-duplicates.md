# 21. Receipt duplicate review

Decision: 2026-10-01. Find candidate duplicate purchases from extracted facts, never image similarity.
A till receipt and its card-terminal slip may be parts of one purchase. Every disposition requires
explicit human confirmation. This amends the receipt boundary in document 15.

## Matching

Compare settled, successfully extracted, living receipts of the same owner. Administrators may
review different owners, but never combine across owners. Indexed purchase date, currency and exact
printed total bound candidate pairs. Missing facts are unknown; currencies are never converted.
Compare normalized merchant/statement descriptor, tax id, receipt number, purchase time, masked card
suffix and items. Require a merchant/identifier anchor or matching card and nearby time. Known distant
times without a matching receipt number indicate separate purchases. Expose supporting facts and
conflicts, and distinguish duplicates, complementary parts and weaker possible matches.

Use pairwise review, not transitive A–B–C grouping; repeated review combines additional parts.
Discovery uses bounded pages and an explicit continuation cursor. An unfinished scan never reports
that the archive has no matches. Manual pair selection supports missing/OCR-damaged facts, with the
same ownership and processing checks.

## Decisions and preservation

- **Different purchases:** remember the pair and exact reviewed revision. Changed data may produce
  another candidate; refreshing the page does not forget a dismissal.
- **Keep one:** choose the survivor; soft-hide the other archive item. Preserve its original file,
  extracted data, previews and ownership.
- **Combine parts:** choose source order, build a PDF with every original page and create one receipt
  owned by the source owner. Stirling converts images and merges PDFs without rasterizing PDF pages
  into thumbnails. Queue ordinary preview/extraction. Hide sources only after successful PDF storage
  and database commit. The extractor treats terminal data as payment evidence for one purchase,
  never adding its total to the till total or duplicating item rows. Code never sums their totals.

Review never overwrites originals or sends them to the shared trash. A forward-migrated
`ReceiptReview` history table retains owner, actor, metadata snapshots, ordered source identities,
reviewed revision, action, result and undo state. Historical identities survive explicit later
deletion/conversion. Authorized history downloads can access hidden originals. Undo restores hidden
sources; for a merge it also hides the generated receipt if it still exists. A later review using
the result must be undone first. Undo does not recreate or modify a deleted/converted result.

Writes require a session and existing CSRF protection. Every read, including history/downloads,
enforces creator/admin access; inaccessible ids look absent. A client operation UUID and reviewed
revision protect retries and stale decisions. Transactions lock receipt/archive rows in deterministic
order and revalidate after PDF generation. Deletion/conversion share this lock boundary. Failures
leave sources visible; cleanup removes only the failing request's unreferenced S3 object. Repeating
an undone merge can reuse its identical preserved PDF, respecting instance-wide file identity.

PDF work runs outside the short database transaction, under the ordinary Stirling gate/deadlines.
Bound sources/intermediate results to a cumulative 128 MiB, output to the configured upload limit
and existing binary cap, and output pages to the receipt limit of 100. Existing profile-aware
maintenance retains preserved originals and receipt artifacts, including hidden receipts.

## API

| Endpoint | Meaning |
| --- | --- |
| `GET /api/receipts/duplicates` | Candidate page and continuation cursor |
| `GET /api/receipts/duplicates/compare?firstId=…&secondId=…` | Compare a manual pair |
| `POST /api/receipts/duplicates/resolve` | Dismiss, keep one or merge ordered originals |
| `GET /api/receipts/duplicates/history` | Paginated owner/admin history |
| `POST /api/receipts/duplicates/history/:id/undo` | Undo while preserving history |
| `GET /api/receipts/duplicates/history/:id/originals/:side` | Source 0/1 signed attachment |

Static controller routes precede `:id`. Next's `/receipts/duplicates` static route coexists with
`/receipts/[id]`; receipt identifiers remain validated UUIDs.

## Interface and acceptance

The shelf offers **Find duplicates** and manual selection of two receipts. The review page has a
candidate queue and decision history. Browse loaded pairs without making a decision. Compare one pair at a time: original-page previews, complete
receipt links, aligned purchase facts, matching reasons and highlighted conflicts. Choose a survivor
or page order before confirming. Explain preservation and re-extraction before a merge. Errors keep
the pair visible; success advances and refreshes the shelf. History exposes result links, source
downloads and Undo. Never suggest that a candidate is already a confirmed duplicate.

Use the established shared design (IBM Plex, archive green, neutral light/dark surfaces, 40 px
controls and 44 px touch targets). The comparison is the visual focus: aligned columns on desktop,
stacked labeled receipts on phones. Use English/Russian, keyboard operation, loading/empty/partial/
error states and 320–1440 px layouts. Do not invent confidence percentages or decorative metrics.
The interaction reference is [Immich's utility](https://docs.immich.app/features/duplicates-utility/);
its visual-similarity mechanism is not used here.

Test normalization, repeated purchases, sparse data, currency/time conflicts, slips and dismissals.
Real DB/API tests cover ownership/admin boundaries, READ-token refusal, stale/concurrent decisions,
deletion/conversion races, rollback, replay, undo dependencies, limits/order and original preservation.
Cover manual selection/confirmations/history in UI tests; review canonical light/dark snapshots in
every viewport and compare again without updating baselines. Complete types, lint, coverage and
hosted/browser acceptance.
