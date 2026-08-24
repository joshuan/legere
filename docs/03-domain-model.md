# 03. Domain Model

Entities, relations, enums, and invariants. This is the conceptual model; the physical schema (Prisma,
indexes, raw SQL) is in [`04-database-schema.md`](./04-database-schema.md).

Conventions: all IDs are UUID v4; all timestamps are UTC (`timestamptz`); soft delete via `deletedAt`
(ADR-015). "Active" record = `deletedAt IS NULL` (and, where applicable, not revoked/expired).

## 3.1. Entity map

```
User ─┬─< Session
      ├─< ApiToken (read-only bearer credentials)
      ├─< UserInvite (createdBy / acceptedBy)
      ├─< PasswordReset (user / createdBy)
      ├─< Collection ──< CollectionItem >── Document
      │        └──────< CollectionShare >── User? (null = whole instance)
      ├─< Document (createdBy — the owner of a document nobody found on a volume)
      └─< LibraryAccess >── Library

Library ─┬─< FileRef >── File (n:1, by contentHash; a path where those bytes lie)
         └─< ScanRun

File ──< DocumentFile >── Document   (ordered: position; per-file crop)

Document ─┬─< DocumentChunk (embeddings)
          ├── Document type (n:1)
          └─< DocumentLink >─ Document   (undirected pair, §3.3.23)

EmailVerification (standalone, keyed by email; used by registration & password reset)
```

## 3.2. Enums

| Enum | Values | Notes |
|------|--------|-------|
| `UserRole` | `ADMIN`, `USER` | |
| `Language` | `EN`, `RU` | `EN` is the default |
| `Theme` | `SYSTEM`, `LIGHT`, `DARK` | |
| `LibraryVisibility` | `ALL_USERS`, `RESTRICTED` | new libraries default to `RESTRICTED` (fail-closed) |
| `FileRefStatus` | `DISCOVERED`, `HASHED`, `MISSING`, `EXCLUDED` | `EXCLUDED` is the mark an admin's deletion leaves on a volume it may not write to (§3.3.9): the bytes are still there and Legere will not read them again |
| `FileOrigin` | `LIBRARY`, `MANAGED` | where a file's bytes live: on the read-only volume (addressed by `FileRef`s) or in our own bucket (uploaded from a browser, or produced by us). A document's own origin is derived from its files rather than stored — see §3.3.10 |
| `StepStatus` | `PENDING`, `QUEUED`, `RUNNING`, `DONE`, `FAILED`, `SKIPPED` | per pipeline step. **`PENDING` and `QUEUED` are the two halves of what used to be one word**: `QUEUED` says a job exists and a worker will get to it; `PENDING` says nothing is scheduled — the artifact is out of date and waits for the hourly sweep (`05 §5.4`), for somebody to ask, or, where the step is paused (`05 §5.4d`), for the pause to be lifted: a held step is `PENDING` and stays there on purpose, which is why the sweep leaves it alone and the screens say which of the two it is. A migration that resets a step produces the second, and while the two shared a name the archive read as busy for the two hours before the sweep noticed, with the queue counter beside it honestly showing nothing. `RUNNING` is persisted, against the earlier decision to treat it as a queue state only: steps that take minutes exist — parsing with picture captions, OCR over a long scan, a local model thinking — and for those minutes a step that has not started reads as "stuck". The mark is best-effort and never the reason a job fails |
| `PageFormat` | `AUTO`, `A4`, `MATCH_SOURCE` | what shape the pages of the canonical take (`05 §5.5` step 1). `AUTO` reads it off the pictures the pages were made from |
| `ValueSource` | `NONE`, `AUTO`, `MANUAL` | who decided a value: nobody, the pipeline, a person. Carried by `typeSource` and `titleSource`, and — as the two words `AUTO`/`MANUAL` inside JSON — by the per-field `sources` of the typed fields (§3.3.10a): one vocabulary, because it is one question |
| `TrashReason` | `REPLACED`, `DOCUMENT_DELETED` | how a file came to be in the trash (`05 §5.7a`). Not "who deleted it" but "what happened to it", which is what decides whether there is a newer copy to compare it with |
| `ScanRunStatus` | `RUNNING`, `DONE`, `FAILED` | |
| `VerificationPurpose` | `REGISTRATION`, `PASSWORD_RESET` | on `EmailVerification` |

## 3.3. Entities

### 3.3.1. User
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| email | string | stored lower-cased; unique among active users |
| passwordHash | string | Argon2id PHC string; never serialized |
| displayName | string | defaults to the local part of the email |
| role | UserRole | |
| language | Language | default `EN` |
| theme | Theme | default `SYSTEM` |
| deactivatedAt | timestamptz? | admin block: login refused, sessions revoked; reversible |
| createdAt / updatedAt / deletedAt | | |

**Invariants:**
- 🔒 At least one active, non-deactivated `ADMIN` must always exist. Any operation that would
  deactivate, demote, or soft-delete the last such admin fails with `LAST_ADMIN`.
- Email uniqueness is enforced among active users (partial unique index).
- Deactivation revokes all sessions and invalidates pending password resets.

### 3.3.2. Session
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| tokenHash | string | sha256 of the opaque cookie token; unique |
| userId | uuid | |
| userAgent | string? | first 512 chars |
| createdAt / expiresAt / revokedAt? | | TTL = `SESSION_TTL_DAYS` (default 30) |

Active session = not revoked, not expired, user active and not deactivated.

### 3.3.3. EmailVerification
One row per verification attempt series; keyed by email, not by user (during registration the user
does not exist yet).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| email | string | lower-cased |
| purpose | VerificationPurpose | |
| codeHash | string | `HMAC-SHA256(AUTH_SECRET, code)` of a 6-digit code |
| attempts | int | burn the record after 5 wrong attempts |
| expiresAt | timestamptz | now + 10 min |
| verifiedAt | timestamptz? | set on correct code |
| ticketHash | string? | sha256 of the single-use registration/reset ticket |
| ticketExpiresAt | timestamptz? | now + 15 min |
| consumedAt | timestamptz? | set when the ticket is used |
| inviteId | uuid? | set when started from an invite link |
| passwordResetId | uuid? | set when started from a reset link |
| createdAt | | |

**Invariant:** at most one *active* record per (email, purpose) — creating a new one supersedes
(deletes) the previous.

### 3.3.4. UserInvite
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| tokenHash | string | unique; sha256 of the opaque URL token |
| role | UserRole | role granted on acceptance |
| emailHint | string? | informational only, not enforced |
| createdById | uuid | admin |
| expiresAt | timestamptz | default now + 7 days |
| revokedAt / acceptedAt | timestamptz? | |
| acceptedById | uuid? | |
| createdAt | | |

Valid invite = not expired, not revoked, not accepted.

### 3.3.5. PasswordReset
Admin-generated reset link for an existing user (there is no self-service "forgot password" in MVP).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| userId | uuid | target user |
| tokenHash | string | unique |
| createdById | uuid | admin |
| expiresAt | timestamptz | default now + 24 h |
| revokedAt / usedAt | timestamptz? | |
| createdAt | | |

Completing a reset requires an email code (same 3-step flow, purpose `PASSWORD_RESET`) and revokes all
of the user's sessions.

### 3.3.6. Library
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| name | string | |
| rootPath | string | path **relative to** `LIBRARY_ROOT` (`""` = the root itself); unique among active libraries; normalized (no leading/trailing `/`, no `..`) |
| enabled | bool | disabled = no scans, content stays visible |
| visibility | LibraryVisibility | default `RESTRICTED` |
| scanIntervalMinutes | int | default 15, min 1 |
| excludeGlobs | string[] | e.g. `["**/.*", "**/node_modules/**"]`; hidden files excluded by default |
| createdAt / updatedAt / deletedAt | | |

**Invariants:**
- 🔒 `rootPath` must resolve to an existing directory inside `LIBRARY_ROOT` at creation time.
- Active libraries must not be nested in one another (`LIBRARY_PATH_CONFLICT`): a new `rootPath` may
  not be an ancestor or descendant of another active library's `rootPath` (a file must belong to at
  most one library).
- Soft-deleting a library removes its documents from user visibility immediately; `FileRef` rows are
  kept (history), documents remain (they may have refs in other libraries — impossible while nesting
  is forbidden, but kept for safety and for restore).

### 3.3.7. LibraryAccess
Grants a user access to a `RESTRICTED` library. `(libraryId, userId)` unique. Rows are hard-deleted on
revoke (pure ACL, no history requirement).

### 3.3.8. ScanRun
Journal of library scans.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| libraryId | uuid | |
| status | ScanRunStatus | |
| startedAt / finishedAt? | | |
| filesSeen / filesNew / filesChanged / filesMissing | int | counters |
| error | string? | on FAILED |

### 3.3.9. FileRef
A physical file inside a library. **No soft delete** — lifecycle is expressed by `status`.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| libraryId | uuid | |
| path | string | relative to the library root; unique per library |
| size | bigint | bytes |
| mtime | timestamptz | filesystem mtime |
| status | FileRefStatus | |
| contentHash | string? | sha256 hex; set when HASHED |
| fileId | uuid? | the file these bytes are, set when HASHED (§3.3.16). A ref points at a file, and the file is what a document holds |
| missingSince | timestamptz? | |
| firstSeenAt / lastSeenAt | timestamptz | |

**State machine:** `DISCOVERED → HASHED` (file-ingest), `HASHED → MISSING` (scan found it gone),
`MISSING → HASHED` (file returned, same hash), `HASHED → DISCOVERED` (size/mtime changed → rehash;
if the new hash differs, the ref re-points to another File — and the file it left keeps its document,
now with one fewer place its bytes can be read from), `* → EXCLUDED` (an admin deleted the document
these bytes were part of, §3.3.10), `EXCLUDED → DISCOVERED` (the bytes at that path changed, so what
is there now is not what was deleted), `EXCLUDED → HASHED` (the file was restored from the trash,
`05 §5.7a` — the hash on the ref is what matched it, so the path is live again without being read).

🔒 **`EXCLUDED` is the whole of what a deletion can do to a read-only volume, and it is why a deleted
document stays deleted.** The library is not ours to write to (ADR-004), so an admin deleting a
document cannot take the original with it (ADR-007): the file lies exactly where it lay, and the next scan
would find it, hash it, discover no file with that hash and give it a new document — the archive
would undo the deletion by itself, every fifteen minutes, for ever. The ref is kept instead of
deleted, pointing at no file, and the scan reads it as "this path is spoken for": `contentHash`,
`size` and `mtime` stay on it so the exclusion can be seen to be about *these* bytes and not merely
about a name. It survives the file going missing from disk, because a tombstone that a moved folder
can clear is not a tombstone.

**The exclusion is per path, and that is the way back.** A copy of the same bytes appearing somewhere
else is a new path with no ref, so it is ingested and becomes a document again — which is how an
admin who deleted the wrong thing gets it back without a screen for undoing deletions, and the
confirmation says as much (`11 §11.5`). The cost of the choice is the other half of it: moving or
renaming an excluded file is also a new path, and the document comes back. Both follow from the same
sentence — Legere knows paths on a volume it does not own — and the alternative, excluding by content
hash for ever, buys tidiness with a deletion nobody can reverse.

### 3.3.10. Document

What a person reads: one paper, however many files it took to capture it. A passport photographed
across forty images is one document; a contract that arrived as a single PDF is one document; the
difference between them is a number, not a kind.

A document owns an **ordered list of files** (§3.3.16, §3.3.17) and exactly one **canonical PDF**
built from them (§5.5) — the thing the viewer shows, the thing Download hands over by default, and
the thing every later step reads. The originals are kept untouched and remain downloadable one by
one; the canonical is rebuildable from them at any moment, so it is an artifact and never a source.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| pageCount | int? | pages of the **canonical PDF**; `NULL` until it has been built |
| title | string | initial = the name of the first file, without its extension. Named by the analysis where nobody has chosen one; editable |
| description | text? | a few hundred characters answering "what is this": what the document is, between whom, what for. Read by the analysis where the field is empty; editable |
| markdown | text? | the extracted Markdown representation |
| searchVector | tsvector | generated from title + markdown + extractedSearchText (see 04) |
| canonicalStatus / previewStatus / markdownStatus / analysisStatus / fieldsStatus / vectorizationStatus | StepStatus | pipeline step statuses |
| extracted | json? | the typed fields of the document's type (§3.3.10a): `{ schema: { slug, version }, values, sources }`. `NULL` until the `fields` step first writes it or a person does |
| extractedSearchText | text? | the searchable extracted values, flattened for the FTS column (04 §4.3). Derived from `extracted` and rewritten whenever it is — never edited on its own |
| processingError | string? | last error message (truncated to 2000 chars) |
| skipReasons | json | why a step is `SKIPPED`, per step — see below; empty for steps that ran |
| autoValues | json | what the pipeline decided — `{title?, description?, typeSlug?, languages?, country?, city?, date?, people?, subjects?, textQuality?, quality?, fields?}` — kept beside the fields a person may correct, so the viewer can show "read as X" next to a hand-set Y. Merged per step, never erased by a correction. `fields` is the last full answer of the `fields` step (§3.3.10a), values only. `textQuality` is the odd one out: not a value the reader may correct but a judgement *about* the text — `GOOD`, `PARTIAL` or `NONE`, answered by the analysis because it is the only step that sees both the pages and what was read off them (`05 §5.5` step 4), and said where the text is read (`11 §11.5`). `quality` is the same kind of thing counted rather than named — see below |
| documentDate | date? | the date written on the document — signed, issued, departing. A date, not a timestamp: a signing has no clock, and midnight in some zone would invent a precision the paper does not have. Read by the analysis, editable |
| languages | string[] | BCP-47 tags of what the document is written in, most likely first — `['ru']`, `['ru','sr-Latn']`. Detected from the extracted text, editable; empty when there was too little text to tell |
| country | string? | ISO 3166-1 alpha-2 of where the document belongs — the issuer's country, the place of an event |
| city | string? | free text, as written in the document |
| failedStep | string? | which step produced `processingError` |
| ocrUsed | bool | whether Markdown came from OCR |
| pageFormat | PageFormat | default `AUTO`; the shape the canonical is built to. Editing it stores an instruction for the next build rather than starting one — the shape of a page is decided while the page is being made (`05 §5.5` step 1), so the pages take a new format the next time they are built (`07 §7.3`) |
| titleSource | ValueSource | default `NONE` — the file name is not a choice; `MANUAL` is never overwritten by auto |
| typeId | uuid? | |
| typeSource | ValueSource | default `NONE`; `MANUAL` is never overwritten by auto — the analysis runs over such a document all the same, is told the type as a confirmed value, and leaves this column and `typeId` alone while recording what it would have chosen in `autoValues.typeSlug` (`05 §5.5` step 4) |
| createdById | uuid? | who created this document by hand: an upload, a split, a combine. `NULL` for a document a library scan found |
| lastEventAt | timestamptz | when this document last changed: the `at` of the newest entry in its journal (§3.3.18), of any type. Never null — see below |
| createdAt / updatedAt / deletedAt | | |

**Languages.** A document may be written in more than one — a bilingual contract has parallel
columns — so this is an array, most likely first. It is detected from the extracted text (an n-gram
detector plus the scripts actually present, offline, no model), and the script subtag is carried
where the same language exists in two of them: Serbian is `sr-Cyrl` or `sr-Latn`, never plain `sr`.
The set decides which languages OCR is given, and a wrong one costs accuracy — `EUR` read with
Cyrillic in the set comes back as `ЕОВ` — so below a length threshold the answer is an empty list
rather than a guess.

**When it last changed.** Three timestamps say three different things and only one of them is an
answer to that question. `createdAt` is when Legere first saw the document. `updatedAt` is when this
*row* was last written — the pipeline bumps it every time it rewrites a step status, and the two
`$executeRaw` merges of `autoValues` and `skipReasons` bypass Prisma's stamping entirely, so it is
an honest "row touched" and a dishonest "edited". `lastEventAt` is the newest entry in the
document's journal (§3.3.18), whatever kind it is: a step finishing, a file attaching, somebody
correcting a field. It exists as a column rather than as `max(document_events.at)` because ranking
an archive by an aggregate over the log is not something an index can serve (`07 §7.1`,
`04 §4.4`), and it is maintained where every event is already written — §3.3.18's single write
site — so it cannot drift from the log it means. A document with **no entries at all** reads as its
own `createdAt`: the moment it came into being is the only honest thing to say about when it last
changed, and it keeps the column non-null.

**The date on it.** `createdAt` is when Legere first saw the file; `documentDate` is what the paper
says. A contract from 2019 scanned yesterday is a 2019 document, and a shelf sorted by when somebody
got round to scanning is sorted by nothing. The analysis reads it — models are good at dates and bad
at little else that is this cheap to check — and keeps only a real calendar day in a plausible
century: `2026-02-31`, `25.07.2026` and "unknown" all come back from models with equal confidence.

**What it says it is.** `description` is the answer to "what is this" for somebody who has never
seen the document: what it is, between whom, what for, in a few hundred characters. The analysis
writes it where the field is empty and records it in `autoValues.description` either way — the
fill-blanks rule the rest of the step follows, because unlike a title a description has a real blank
to fill. It is what makes an unfamiliar document judgeable without opening it.

**What it is called.** `IMG_20260714_113355.jpg` is not the name of a document; it is the name of a
file, and a shelf of them is unreadable. So the analysis reads a title off the document — what a
person would write on the folder — and `titleSource` says who decided:

| `titleSource` | Meaning |
|---|---|
| `NONE` | whatever the file was called. Nobody has decided anything; the analysis may name it |
| `AUTO` | the analysis named it, and may name it again on the next run |
| `MANUAL` | a person titled this document, and no machine overwrites it |

The same rule as the document type, for the same reason — and the same way back: `reset: ['title']`
restores what the analysis read and returns the field to `AUTO`, so it stops claiming a person chose
it. A file name is deliberately `NONE` and not `AUTO`: nothing read it off the document, and the day
a title is worth having is the day the pipeline can offer a better one.

**Where a document belongs.** `country` and `city` answer "where is this from" — the issuing office
of a contract, the departure city on a ticket. They are inferred by the AI step when a provider is
configured, because the evidence is rarely literal: a Montenegrin train ticket says `ŽPCG` and
`Podgorica`, never "Montenegro", and the operator's full name lives in the logo, which is a picture.
Without a provider both stay empty until somebody fills them in; both are editable either way, and a
value a person set is never overwritten (the rule that already governs the document type).

**How well each reading went.** `autoValues.quality` is what the pipeline thought of its own work on
this document, as three marks from 0 to 100 — `{legibility?, extraction?, confidence?}`. The analysis
answers the first two, because it is the step that sees both the pages and what was read off them:
**legibility** is how readable the pages themselves are, **extraction** how faithfully the stored
text carries what they visibly say (`05 §5.5` step 4). The `fields` step answers **confidence**, once
over its whole reading (step 5). All three are the machine's own account of itself rather than
anything read off the paper, which is why they are in `autoValues` and not among the columns a person
may correct: there is nothing here to correct, only something to be told. The key is written by two
steps and merged one mark at a time, like everything else in this column — an analysis that runs
alone leaves the `fields` step's mark standing, and vice versa.
🔒 **A missing mark is not a zero.** Absent means the step did not answer that question — an older
provider, a call shown no pages, an answer that came back as a word — and the viewer draws nothing
where there is nothing, rather than a nought nobody's work earned.
🔒 **And a mark gates nothing.** It is an opinion about an output, held by the thing that produced
it; no re-run, no failure and no threshold anywhere reads one (`05 §5.5` step 4). The same marks are
written onto the step's `STEP_FINISHED` entry beside what it cost (§3.3.18), so the journal keeps
what each run thought of itself and a later run cannot quietly rewrite the record of an earlier one.

**A step may be `FAILED` without owning the failure.** The pipeline is a chain: the preview and the
extraction read the canonical PDF, and the analysis and the vectorization read the extracted text
(`05 §5.5`). A step whose input was never produced is `FAILED` too — there was nothing for it to work
on, and calling that `SKIPPED` would say the document did not need it — but `processingError` and
`failedStep` go on naming the step that actually broke. So `failedStep` is *the* failed step and not
*a* failed step: a document may show three of them and point at one, which is the one worth reading.
A dependency that was `SKIPPED` rather than broken is inherited the same way, reason and all, so the
reader is told the format could not be rendered rather than that the embeddings found nothing.
Which is also why the pair outlives a run that never touched the step it names: a reprocess clears
them only where it may re-run that step (`07 §7.3`), because a run that leaves a failure standing and
takes away the record of it leaves the document pointing at nothing.

**Skip reasons.** `SKIPPED` on its own reads like something went wrong, and four of the six steps
skip for reasons an operator can act on. Each skipped step records why, from a closed set:

| Reason | Meaning |
|---|---|
| `NOT_NEEDED` | nothing to do for this document — no file of it is an image, so there is nothing to crop |
| `UNSUPPORTED_FORMAT` | the format has no representation the product can build |
| `NOT_CONFIGURED` | the instance has no classifier / embeddings provider (docs/05 §5.5) |
| `NO_SCHEMA` | the document's type carries no field schema, or the document has no type at all (§3.3.10a) — for most of an archive this is the whole of the `fields` step, and it is a fact about the type rather than a problem with the document |
| `NO_TYPES` | retained for documents processed before step 4 became a full analysis; no longer produced — with no document types defined the step still runs, because it also reads where the document is from |
| `NO_TEXT` | there is no extracted text to work from: the extraction ran and yielded none, or it has not run at all — which is what a reprocess asking for the analysis or the vectorization on their own leaves them looking at (`05 §5.5`) |
| `TOO_MANY_PAGES` | longer than `CLASSIFIER_AUTO_MAX_PAGES`: not analysed unasked at all, because a verdict read off the first ten pages of a forty-page contract looks exactly like one read off the whole (`05 §5.5` step 4). A person may still ask, from the document's own page |

There were eight. `MANUAL_TYPE` — a person chose the document type, so the analysis was skipped
whole — is gone from the set, and a migration cleared it from the documents that carried it. It was
written when the analysis could only have overwritten the choice, and what it cost was everything
*else* that step reads: a manually-typed document never got a date, a place, its people or a
description again. The type now travels into the call as a confirmed value instead of standing in
front of it (`05 §5.5` step 4), and the protection lives where it belongs — the step runs, and
`typeId` and `typeSource` are simply not among the columns it writes.

**Derived state (computed, not stored):**
- `origin`: `LIBRARY` when at least one of the document's files is a library file, `MANAGED`
  otherwise. Not a column — a document that absorbs an upload does not change kind, it gains a file.
- `availability`: `AVAILABLE` when every file of the document can be read right now; `PARTIAL` when
  some can and some cannot; `UNAVAILABLE` when none can. A `MANAGED` file is always readable — the
  bucket is ours and does not go missing behind our back — so only library files move this needle.
  **The canonical PDF outlives all of them**: a document whose volume was unplugged still reads,
  still searches and still downloads as a PDF, and says plainly that its originals are elsewhere.
- `processing`: `true` while any step is `PENDING`, `QUEUED` or `RUNNING` and prerequisites are not `FAILED`. A document nothing is scheduled for is still unfinished — the reader is told it is not done, and the step's own status is where "and nothing is coming for it right now" is said. A step held by a pause (`05 §5.4d`) is one of those: the document is unfinished and the flag says so, while the page saying *which* step it is is where the pause is named.
- `fileCount`, `sizeBytes`: how many files the document is made of and what they weigh together.

**Invariants:**
- A live document has ≥1 file. Removing the last one is refused (`DOCUMENT_LAST_FILE`); a document
  is emptied by deleting it, not by taking its parts away one at a time.
- Deduplication is a property of files, not documents (§3.3.16): two documents may hold the same
  file no more than one may — a file has exactly one home.
- 🔒 **Deleting a document (admin) is a real deletion, and the one place ADR-015 does not hold.** The
  row goes, and with it the journal, the chunks, the Markdown, the collection items, the links to
  people and subjects, the links to other documents (§3.3.23) and the `DocumentFile` rows. Its **artifacts** go from the bucket too (§9.2):
  they are derived from files that are no longer arranged into anything, and they are the one part
  of a document that can be built again from what is kept.
  **Its files go to the trash** (`05 §5.7a`), not to the incinerator. A file has exactly one home
  (§3.3.16) and this document was it, so they are not re-homed into documents nobody asked for — but
  they are the bytes, the only thing here that no rebuild can recover, and they wait: an upload until
  the retention window closes, a library original until the person who owns that volume clears it.
  What could never have gone in any case is a `LIBRARY` file's bytes on the volume, and one `FileRef`
  per path holding them stays `EXCLUDED` so that no scan brings the document back (§3.3.9).
  The document itself is gone irreversibly, which is why deleting one is an admin's and why the UI
  spells out what goes and what waits before it happens (`11 §11.5d`).
- A document **absorbed into another** (`05 §5.6`) is a different thing wearing the same word and
  keeps the soft delete it always had: its files were not destroyed, they moved, and the emptied row
  is a record of where they came from.

**Artifact keys (deterministic, no DB columns — see 09):**
`documents/{id}/canonical.pdf`, `documents/{id}/preview.jpg`, `documents/{id}/thumb.jpg`.
A document owns no source bytes of its own: those belong to its files
(`files/{fileId}/original.{ext}` for managed ones, a path on a volume for library ones).

### 3.3.10a. Typed fields

What a paper of a given type **states**, as data: a receipt names a vendor, a total and a day; a
passport a holder, a number and an expiry. The generic pipeline already reads everything else about
such a document — its text, its type, its date, its people — and this is the last step of that
reading: the facts that are typed because the *type* types them (ADR-022).

**The schema is the type's, and it ships with the code.** A **field schema** is a versioned list of
field specs — key, kind, whether the value is searchable, whether it belongs on a card — kept in a
registry in `src/shared/contracts`, keyed by the document type's slug. It is data, deliberately:
today the registry is a constant and only `receipt`, `passport`, `id-card`, `flight`, `invoice`,
`lab-report` and `civil-certificate` carry one; the day schemas become admin-editable they move into
a table without the stored answers changing shape, because every answer already names the slug and
version it speaks. Field **kinds** are the closed set `string`, `number`, `date` (a calendar day,
the `documentDate` rule), `money` (`{ amount, currency }`, one fact — an amount without its currency
is not a fact), and `table` (rows of `string`/`number` columns — the lines of a receipt). Field
labels are not in the registry: they are message-catalog keys derived from the slug and the field
key, localized like everything else (ADR-016).

**One `flight` for every paper an airline prints.** An e-ticket, an itinerary receipt and a boarding
pass are one journey wearing three layouts: they differ in which fields they fill, not in what they
are. So the booking is stated once — the `airline`, the `bookingReference` all three papers repeat,
and the `totalPrice` where the paper names a price at all — and a `coupons` table carries one row
per passenger per leg. A single-leg ticket issued for four people is four rows; a two-passenger
itinerary is two; a boarding pass is one row and no price. Three types instead of one would file the
same journey under three names and leave the reader to guess which of them the drawer holds. A slug
that carries a schema is also a document type the instance has to hold — the reading happens under
the type, and a schema nothing points at is read for nobody — which is why `flight` joins the types
the dev seed creates (`04 §4.6`); on a live instance an admin adds it as they add any other
(§3.3.12).

**One `invoice` however many providers a bill collects.** A utility bill is a paper with one payable
total, and the combined municipal one — water, heating, waste, the lift, the aerial, the management
company, the building's insurance, each rendered by somebody else — is still that paper: seven
services, one collector, one sum at the foot, one transfer that pays it. So the bill is stated
once — the `vendor` who is owed, the `accountNumber` a payment quotes, the `billingPeriod` charged
for, the `dueAt` it must be paid by and the `totalDue` actually asked for, arrears and penalties
folded in where the paper folds them — and an `items` table carries a row per line with the
`provider` of that line beside it: equal to the vendor on a single-provider bill, one of seven on
the combined one. Splitting the paper into seven invoices would invent documents the drawer does not
hold, and leave none of them matching the one payment that settled them all. The bill names its
currency once, on `totalDue`; every amount on a line — the rate, what was accrued, the adjustment,
the line's own due — is a bare number in it, because a bill charged in two currencies is a bill
nobody sends. `invoice` needs no seeding of its own: it is among the types migration 1 already
inserts (§3.3.12).

**A receipt is also a line of a bank statement.** The second job of a till receipt in an archive is
answering "which entry on the statement is this": the statement says
`TROPIC MALOPRODAJA VISEGRAD BA` and a sum, and the paper in the drawer is the only thing that says
what was bought. So `receipt` **v2** keeps the vendor as the shop spells it and adds the way a bank
spells it (`statementDescriptor`), the minute of the purchase (`purchasedTime` — two receipts from
one shop on one day differ by nothing else), how it was paid (`paymentMethod`, `card`), and what a
fiscal receipt is filed under (`vendorTaxId`, `receiptNumber`, `taxAmount`); the lines gain the unit
price and the discount printed against them. `paymentMethod` is the field oftener inferred than
read, so its hint teaches the markings themselves: a masked card number, a POS/TID/RRN line,
"Безналичными" or "Platna kartica" say card; "Наличными", "Сдача" or "Gotovina" say cash.
🔒 **A cash-machine slip and an exchange receipt stay `receipt`**, with the bank or the *menjačnica*
as the vendor: a withdrawal has a merchant, a moment, a sum and a card, which is every field that
matters here — a type of its own is owed only when that proves too small to hold one, and not
before.

**One row per analyte, and the panels flattened.** A clinical lab report is a header and a table:
who was tested, by which laboratory, under which order number — and then result after result,
printed under headings that group them into a blood count, a biochemistry panel, a single
qualitative test. Those headings are typography rather than structure, so `lab-report` states the
header once — the `patient`, the `facility`, the `orderNumber` and the two dates — and pours every
panel into one `results` table: `analyte`, `value`, `unit`, `reference`, `flag`, a row apiece. The
`value` is a *string* because half of what a laboratory answers is not a number: "positive", "not
detected", "<0.5" are results, and a numeric column would drop them along with the reason the report
was ordered. A column typed that way holds both ends of it: a number answered where the column asks
for text is kept as the digits it was printed with — the mirror of a number column already reading
"12,40" as the number it is. Of the two dates the one that matters is `collectedAt`: a result speaks
about the morning the blood was drawn and not the afternoon the printer ran, which is why that is
the day on the card and `reportedAt` merely a fact beside it. `lab-report` joins the types the dev
seed creates (`04 §4.6`), beside the broader `medical` the catalogue already carries for everything
a laboratory did not print.

**A card in a wallet and a blank from a registry office are different papers.** `id-card` and
`passport` are for what a person carries to be shown: a photograph, a number, an expiry, a holder.
What a *ЗАГС* or a *matična služba* prints on a numbered blank — a birth, a death, a marriage, a
divorce — is none of those: it never expires, and its number is the number of the form it was struck
on. So `civil-certificate` states what such a paper actually carries: the `certificateNumber` of the
blank, the `actNumber` and `actDate` of the record in the registry book standing behind it, the
`issuedBy` office, the event itself as `eventDate` and `eventPlace`, and the `issuedAt` day the
blank was handed over — which on a duplicate drawn forty years later is not the day of the event.
🔒 **Who the paper is about is not a field of it.** The child, the deceased, the two who married are
*people*, and people are what the document's people links are for (§3.3.19): a name copied into a
field beside those links would be a second vocabulary for the same person, unsearchable as a person
and uncorrectable as one. The wallet cards keep their `holder`, because a card states its bearer the
way it states its number — and both gain the state that issued them. `id-card` **v2** and `passport`
**v2** add `issuingCountry`: the document's own `country` is one coarse code for where the paper
belongs, which the analysis may fill with the place of the event or the country the drawer sits in,
while which state issued the card is printed on the card and wanted exactly — a Serbian archive
holding a Russian licence answers "Russia" here and nothing else does. `id-card` **v2** adds the
`birthDate` a licence prints and the `categories` it grants, the vehicle classes being the one thing
a licence says that no other card in a wallet does. Both are version bumps and neither is a type
change: the next `fields` run re-reads under the newer schema and every correction survives it
(below). `civil-certificate` joins the dev seed's types the way `flight` does.

**What is stored.** One JSON on the document — `extracted` — self-describing:

```
{ schema:  { slug: 'receipt', version: 2 },
  values:  { vendor: 'Voli', purchasedAt: '2026-05-12', total: { amount: 12.4, currency: 'EUR' }, items: [...] },
  sources: { vendor: 'AUTO', purchasedAt: 'MANUAL', total: 'AUTO', items: 'AUTO' } }
```

`values` holds the current answer, corrections included; `sources` says who decided each field, in
the two words of `ValueSource` that apply (a field with no value has no entry — that is its `NONE`).
The model's own last reading lives in `autoValues.fields`, values only, recorded whether or not it
was applied — which is what lets the viewer say "read as X" under a corrected value and offer the
way back (`11 §11.5`). `extractedSearchText` is the projection the FTS column reads: the values of
searchable fields, flattened to text, rewritten by whatever writes `extracted` (04 §4.3).

**Fill-blanks, per field.** The `fields` step (05 §5.5 step 5) applies the model's answer only where
`sources` does not say `MANUAL` — the rule the analysis already follows, one level finer. A person
edits a field through `PATCH` (07 §7.3): setting a value marks it `MANUAL`, clearing it (null)
removes value and source both, which is how a field is asked to be read again; `reset` restores what
the model read and marks it `AUTO`, so a value put back stops claiming a person chose it.

**A version bump is not a type change.** A schema that gains fields keeps its slug, and this rule is
keyed on the slug: the next `fields` run simply reads the paper again under the newer schema — every
`MANUAL` value survives it, field by field, the fields the version added arrive as blanks nobody has
filled yet, and a field the version dropped goes with the reading it belonged to. Which is the whole
ceremony of a bump: raise the number in the registry, and the archive catches up one document at a
time, as each is processed, without a migration and without losing a correction. Only a change of
*slug* replaces a reading wholesale, and for a different reason entirely (below).

**Validation is per field, in code, not in the model's gift.** A date must be a real calendar day in
a plausible century; an amount a finite number; a currency a plausible ISO 4217 code; a table
validates row by row and keeps the rows that parse. An invalid field is dropped and the rest of the
answer stands — the rule the analysis follows for the same reason: an invented value in one field
must not discard a good one beside it.

🔒 **The fields belong to the type, so a type change replaces the reading.** The same paper asked for
a receipt's fields and a contract's is two different questions, and an answer kept across the switch
would be values speaking a schema the document no longer has. A manual type change re-queues the
step (07 §7.3), and the step, finding `extracted.schema` disagreeing with the type it now reads for,
replaces the answer wholesale — manual corrections included, because they were corrections to fields
this document no longer carries. The journal keeps what they were (§3.3.18). A type merely
*soft-deleted* out of the catalogue is gentler: the values stay as a record (the schema lives in the
code, so they still render), and the next run skips with `NO_SCHEMA`.

**No catalogue, on purpose.** Extracted values live on the document and nowhere else: there is no
instance-wide list of passport numbers the way there is one of people (§3.3.19), because nothing
files by these values — they are read *on* a document by whoever may read the document, and the
access rule of §3.4 is the whole of their protection.

### 3.3.19. Person

🔒 **The catalogue is instance-wide, and that is a decision rather than an oversight.** Every signed-in
user reads every person and every subject, with the count of documents each holds — and those rows
are written by the analysis step reading document text, including text inside libraries that reader
cannot open. So a name can be learned here that its documents would not reveal. The catalogue is kept
this way because it is what documents are *filed by*: a shared vocabulary that everyone corrects and
merges is the point of it (§3.3.20a), and one scoped per reader would fracture into as many
vocabularies as there are grants, with merges that mean different things to different people. What is
protected is the documents themselves — the drill-down applies the access rule
([`03 §3.4`](#34-access-model-authoritative-summary)), so a name may be visible while everything filed
under it is not. An instance where that trade is wrong is an instance that should not put those
documents in the same Legere.



Who a document is about: the parties to a contract, the passenger on a ticket, the patient in a
report. A shared catalogue rather than names written on each document, so the same person on forty
documents is one row — and correcting a spelling corrects all forty.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | string | unique among living rows, case-insensitively — enforced on `nameFolded`, see below |
| nameFolded | string | the name folded for identity: Unicode-lowercased, whitespace collapsed. Written by the application on every create and rename, never by hand |
| note | string? | whatever tells two people of the same name apart, in the owner's own words |
| createdAt / updatedAt / deletedAt | | soft delete (ADR-015): the links stay, only new documents stop being able to name them. 🔒 Enforced, not merely offered: `PATCH /api/documents/:id` refuses a deleted id with `PERSON_NOT_FOUND` rather than re-linking it. A document that already names one says so — the detail carries `deleted: true` for that entry, and the viewer strikes it through, because a link that survives a deletion is a record and has to read as one |

`DocumentPerson` links the two, many-to-many, **without a role**. A role — buyer, seller, payer — is
real and wanted, but what the roles *are* is not knowable yet, and a half-guessed vocabulary is worse
than none. Open question in §3.5.

**One row per living name, in any alphabet.** "Case-insensitively" was the promise from the start,
and for a Cyrillic archive it was silently broken: the database is created with collation `C`, whose
`lower()` folds ASCII alone, so `ШЕРШНЕВ` and `Шершнев` passed the unique index as two people — and
did, twenty-two rows of one man. The fold is therefore the application's, not the database's:
`nameFolded` is the name Unicode-lowercased with its whitespace collapsed, written by the same code
on every path that writes a name, and **every lookup that asks "is this name already here" asks it
of the fold** — the analysis matching what it read, the uniqueness check ahead of a create or a
rename, the merge checking the survivor's name. The same rule holds for subjects and their kinds
(§3.3.20, §3.3.20a). The database's own unique index moves onto the fold once the duplicates the
old index admitted have been merged away — deliberately after the cleanup, because an index cannot
be built over rows that already violate it (backlog M49).

**Who may do what.** Reading the catalogue and adding to it are open to anyone signed in, because the
analysis step adds names on its own and whoever corrects it must be able to add the one it missed
without waiting for an admin. Renaming and removing are an admin's: both reach across every document
that names the person. 🔒 Open is not unbounded (SEC-56): the creates are rate-limited — a person
corrects a few rows a minute, and a namespace every user reads is not one account's to fill by
script — and the list endpoints answer pages like every other list (`07 §7.1`).

**Merging.** The analysis reads a name as each document spells it, so one person arrives as three
rows. Merging folds them together: the **oldest row survives** — the one the archive has been calling
this person longest — takes the name that was chosen, receives every document link the others had
(with the duplicates a document that named two of them would otherwise get collapsed into one), and
the rest are soft-deleted. All of it in one transaction: a half-moved merge would leave documents
pointing at somebody nobody can see. The surviving name may not collide with a person who was not
part of the merge — that would be two people becoming one by accident.

**The analysis step fills it in — and recognises before it creates.** The model is shown the people
already in the catalogue, each with its note and the spellings merges folded into it, and told to
answer with the catalogue's own spelling when the document is genuinely about one of them —
`SHERSHNEV/EVGENII MR` on a boarding pass is the person the catalogue already calls by his full
Cyrillic name — and to write the document's spelling only for somebody new (`05 §5.5` step 4).
Each answered name is then matched against the catalogue on the fold and created when it is
missing. Creating is still the point — an archive where the machine may only pick from what
somebody already typed would need somebody to type everything first. Fill-blanks-only, like the
rest of the analysis: a document that already names people is one where somebody has decided, so
the answer is recorded in `autoValues.people` and not applied.

**The catalogue notices its own duplicates.** What arrives as three rows is *recognisably* three
rows — a case change, a missing diacritic, a transliteration, a typo in a patronymic, an airline's
`SHERSHNEV/EVGENII MR` — and a person should not have to read a hundred and thirty names to find the
twenty that are seven. The analyst (`05 §5.6c`) is therefore asked to read the living catalogue and
propose merge groups, each carrying the spelling it would keep and the spellings it read as the same
person. A proposal is a question, like every suggestion in Legere (`05 §5.6a`): nothing merges until
an admin confirms it through the same merge that has always existed, the groups are stored nowhere,
and a refusal is not remembered. Suggesting is an admin's, exactly because merging is. The note on a
row is part of what the analyst reads — it is what tells two people of the same name apart, so a
shared name with distinct notes is a reason *not* to propose — and 🔒 names and notes reach the model
as fenced data, never as instructions, because the catalogue is writable by every signed-in user.

### 3.3.20. Subject

What a document is *about*: a flat, a car, a country, a company. The **kind** says what sort of thing
it is, the **name** says which one — a lease is about *that* flat, a tax return about *that* country,
and "the papers for the car" is how anybody actually looks for them.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| kindId | uuid | which `SubjectKind` this is one of |
| name | string | which one, as the document writes it |
| nameFolded | string | the identity fold, written by the application (§3.3.19) |
| note | string? | **how to recognise this one**: the address, the plate, the account number, the other party — whatever a document about it would mention. Written by hand, read by the analysis |
| createdAt / updatedAt / deletedAt | | soft delete (ADR-015): the links stay, and behave exactly as a deleted person's do (§3.3.19): refused on a new document, marked on an old one |

Unique on `(kindId, nameFolded)` among living rows — the fold of §3.3.19, because the database's
`lower()` never folded Cyrillic and "the same flat entered twice" is exactly the failure this table
exists to prevent. The kind is part of the identity because "Montenegro" the country and
"Montenegro" the boat are two things. The suggester of `05 §5.6c` reads this catalogue too,
kind-aware — a duplicate may sit across two spellings of one kind — and points beside its groups at
**placeholders**: rows whose name is a kind rather than a thing, offered for deletion one confirmed
row at a time.

### 3.3.20a. SubjectKind

What sort of thing a subject is: `apartment`, `car`, `country`. A catalogue of its own, not a string
repeated on every row — renaming "flat" to "apartment" is then one edit rather than forty, the browse
screen has something to list, and the same kind cannot exist twice under two spellings.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | string | stored exactly as typed, in any language and any case; unique among living rows, case-insensitively — on the fold of §3.3.19 |
| nameFolded | string | the identity fold, written by the application (§3.3.19) |
| note | string? | what this kind is for, in the owner's own words |
| createdAt / updatedAt / deletedAt | | soft delete (ADR-015) |

**Named in the owner's words.** "Квартира" is a kind; turning it into "apartment" is the product
deciding how somebody's archive is spelled. The name is stored as typed and only the uniqueness check
ignores case. The analysis is shown the kinds already in use and told to reuse one where it fits —
two spellings of one kind split a shelf in half — and to name a new one in the document's own
language when none does.

It was free text until the catalogue existed, on the argument that the list of kinds a household
files by is not knowable in advance. That argument was for the *list*, not for the *storage*: the
list is still open — anyone signed in may add a kind, and the analysis adds the ones it meets — but
now it is a list, with rows that can be corrected.

**Who may do what**, exactly as for people (§3.3.19): reading and adding are open to anyone signed
in, because the analysis adds kinds on its own and whoever corrects it must be able to; renaming and
removing are an admin's. 🔒 **A kind still used by a living subject cannot be removed**
(`SUBJECT_KIND_IN_USE`): a subject with no kind is not a thing anybody can file by, so the subjects
go first.

**Merging**, because kinds duplicate like everything else the analysis writes — `жильё` and `Жильё`
by case, `car` beside `автомобиль` by language, `жилё` by typo — and a shelf split in half files
nothing well. The rule is the people's rule (§3.3.19) with one addition for what a kind *holds*:
the **oldest kind survives**, takes the name that was chosen, and receives every subject the merged
kinds held. Where two of those kinds held the same thing — one folded name (§3.3.19) on both sides,
`CHEVROLET LACETTI` under `car` and under `автомобиль` — the things are folded too: the oldest
subject survives, receives the document links of its twins with duplicates collapsed, and the
twins are soft-deleted, because a merge whose result violates the `(kindId, nameFolded)` identity
would be a merge that undid the table's own rule. All of it in one transaction; the surviving name
may not collide with a kind outside the merge; and the suggester of `05 §5.6c` proposes these
groups the way it proposes people.

**Recognising one again.** After the first months an archive stops meeting new things: almost every
document arriving is about a flat, a car or a company that is already in the catalogue. So the
analysis is given the catalogue — each thing with its kind, its name and its note — and told to
answer with one of them, spelled exactly as it is there, when the document is about it. A new row is
what it does when nothing matches, not what it does by default. The note is what makes that possible:
"Njegoševa 5, ap. 12, cadastral 1234, landlady Marija Petrović" is how a lease, a bill and an
insurance policy are all recognised as being about one flat, none of which spell it the same way.

**Merging** works exactly as it does for people (§3.3.19), with one addition: the rows being folded
together may disagree about their kind, so the merge is told which kind the survivor is filed under.

Same access and the same fill-blanks-only rule as people (§3.3.19): the analysis names things and
creates the ones the catalogue has never seen, matching on `(kind, name)` on the fold (§3.3.19); a
document that already says what it is about is left alone and the answer recorded in
`autoValues.subjects`.

**Measured limitation.** A 12B local model answers this field with the document itself — a train
ticket "about" that ticket's number — even when the prompt says in as many words not to. The prompt
says it anyway, because a stronger model obeys it; the field is corrected by hand meanwhile, and a
correction is never overwritten.

### 3.3.21. Setting

An instance knob an admin turns at runtime: a key, a JSON value, and when it last changed.

| Field | Type | Notes |
|---|---|---|
| key | string | primary key; `queue` is the first one — concurrency per queue, units inside a job, which queues are paused, and which steps of the pipeline are held (`05 §5.4d`) |
| value | json | whatever that key means |
| updatedAt | timestamptz | |

A key-value table rather than a column per setting, because these arrive one at a time and a
migration per knob is a migration nobody wants to write. **Env stays the default** ([`12 §12.4`](./12-build-config-run.md)):
a row here is somebody overriding one deliberately, so an instance with an empty table behaves
exactly as it always has. A value whose shape this version does not recognise is ignored rather than
crashing what reads it — a setting written by a later version must not stop the workers from
starting.

### 3.3.22. ApiToken

A credential a user issues to themselves so that something other than a browser can **read** this
instance: a script, a scheduled export, an assistant. Every token this instance issues is read-only —
there is no scope field, because there is no second kind ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)).

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| userId | uuid | the owner; the token acts as them and sees exactly what they see |
| name | string | what it is for, written by the owner ("laptop export script"); 1–128 chars |
| tokenHash | string | unique; sha256 of the opaque bearer token, which is shown once and never stored |
| expiresAt | timestamptz | required; `API_TOKEN_TTL_DAYS` (default 90) unless the owner chose otherwise, max 365 |
| lastUsedAt | timestamptz? | best-effort, written at most once a minute per token |
| revokedAt | timestamptz? | revocation by the owner |
| createdAt | | |

Usable token = not revoked, not expired, owner active and not deactivated — the same three questions
a session answers (§3.3.2), asked of a different credential.

**Invariants:**
- 🔒 A token authorizes **safe HTTP methods only**. A mutating request carrying one is refused with
  `READ_ONLY_TOKEN` before it reaches a controller, whether or not the token itself is valid.
- Deactivating or soft-deleting a user revokes their tokens, exactly as it revokes their sessions.
- The plaintext token exists in one response and nowhere else: not in the database, not in a log,
  not in a later listing.

### 3.3.18. DocumentEvent

The history of one document: how it came to be what it is. The `Document` row carries the *current*
state of every step; this is the only place that says which run failed, what a value was before
somebody corrected it, and who corrected it.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| documentId | uuid | cascade on physical delete; a soft-deleted document keeps its log (ADR-015) |
| type | DocumentEventType | `CREATED`, `FILE_ATTACHED`, `FILE_MISSING`, `QUEUED`, `STEP_STARTED`, `STEP_FINISHED`, `META_CHANGED`, `LINKED`, `UNLINKED` |
| actorId | uuid? | who did it; **null is the pipeline acting on its own** |
| payload | json | what the entry needs to be readable: `step`, `status`, `reason`, `error`, `steps`, `source`, `path`, `changes` (field → `{from, to}`), for a link: `otherDocumentId` and `otherTitle` (a record, not a live reference — the other side may be gone by the time this is read), and for a step: `service`, `endpoint`, `requestId`, what it cost — `durationMs`, `chars`, `pages`, `ocrUsed`, `promptTokens`, `completionTokens` — and what it made of its own work: `legibility` and `extraction` on the analysis, `confidence` on the fields (§3.3.10) |
| at | timestamptz | |

**What it cost.** The entry that *settles* a step says how long it took (`durationMs`) — the pair of
entries already brackets it, and subtracting two timestamps by hand is not a thing a reader should
have to do — what came out of it (`chars` of text, `pages` worked over, whether `ocrUsed`), and what
a model reported spending (`promptTokens`, `completionTokens`, read from the provider's own
accounting because only it knows what its tokenizer did). A step in progress reports none of them: it
has spent nothing yet. A missing number is not a zero — it means that step does not answer that
question. "It took four minutes" and "it returned nothing" are the two halves of one question, and
until this the log answered neither.

**And what it made of its own work.** The same entry carries the step's marks out of 0 to 100 —
`legibility` and `extraction` on the analysis, `confidence` on the fields (§3.3.10) — beside the
numbers above and under exactly the same rule, because they are the same kind of thing: an answer a
step gave about one run of itself. A step re-run three times has three entries, each keeping what
*that* run thought, which is what makes "it got worse when we changed the model" a question the
archive can answer about itself. They are recorded and nothing reads them to decide anything.

**Which service did it.** A step that talks to a container records which one (`service`), where it
lives (`endpoint`) and the id it was asked under (`requestId`). The id is generated per step and
carried by every request that step makes, as `X-Request-Id` — the header this instance answers its
own callers with — so a failed step in this log can be found in Stirling's or Docling's. Both entries
of a started/finished pair carry the same id, because the id is read from the call in progress rather
than passed from one frame to the next. A step the pipeline does by itself — resizing an image,
chunking text — names no service, since there is no other log to go and read. `endpoint` names a
container on an internal network: it is recorded for everybody and returned only to an admin, who is
the only one who can act on it.

🔒 **Where the bytes were seen.** An entry whose `source` is `LIBRARY` carries the path the file
occupies on a volume. Files are deduplicated instance-wide, so the same bytes can be referenced from
several libraries and that path may name a folder inside one the reader was never granted — which
`GET /api/documents/:id` already refuses to show, filtering a file's refs to visible libraries
(08 §8.5). The log agrees with it: `path` on a `LIBRARY` entry is recorded for everybody and
returned only to an admin, like `endpoint` above. A path from an upload, a split or a combine names
a file of this instance's own and is returned to whoever may read the document. This is
deliberately blunt — it withholds the path from a reader who could have seen that library too;
naming the library in the payload, so the entry can be filtered rather than stripped, is the better
answer and a forward-only change.

Read newest first, by whoever may read the document itself. Writing an entry must never be the
reason an operation fails: a document that processed correctly but could not be written about is
still a processed document. Every step status the pipeline writes produces an entry, routed through
one method rather than recorded at each call site — a log is only worth reading if nothing is
missing from it.

**The newest entry, kept beside the document.** "When did this document last change" is the `at` of
the newest entry here, and an archive is ranked by it (`07 §7.1`). `max(document_events.at)` per row
is a correlated aggregate no index can serve, so the answer is denormalised onto
`Document.lastEventAt` (§3.3.10) — and it is written by **this** single write site, the same one
every event already goes through, which is what makes the column and the log the same fact rather
than two facts that drift. The write moves the value forward only (`GREATEST`), so two entries of
one run landing out of order cannot undo the newer one, and it deliberately leaves `updatedAt`
alone: recording that something happened is not itself an edit of the document.

### 3.3.11. DocumentChunk
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| documentId | uuid | |
| index | int | 0-based; unique per document |
| content | text | the chunk text |
| charCount | int | |
| embedding | vector(1024) | pgvector; cosine ops. The width is the model's, and it is fixed by the column — see `04 §4.5` for what changing it costs |
| model | string? | the embedder that produced this vector (`EMBEDDINGS_MODEL`, `12 §12.4`). Null only on a chunk written before this column existed |

Chunks are replaced wholesale on (re)vectorization: delete all → insert all (in one transaction).

🔒 **A chunk says which model made it**, because two models in one table is a search that quietly
lies: cosine distance between vectors from different embedders is a number with no meaning, and a
half-finished model switch would otherwise be invisible until somebody noticed the results were
wrong. It is written by the step that writes the vector (`05 §5.5` step 6) and counted per model on
`/admin/queue` (`07 §7.3`).

### 3.3.12. Document type
Admin-managed reference list.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| slug | string | unique among active; kebab-case; stable identifier used by the classifier |
| name | string | display name (English; shown as-is in both locales) |
| description | string? | shown to the classifier as guidance and to admins |
| createdAt / updatedAt / deletedAt | | |

Soft-deleting a document type sets `typeId = NULL`, `typeSource = NONE` on its documents
(application-level cascade inside the same transaction).

**Seeded defaults** (created by the first migration's seed, editable later): `passport`, `id-card`,
`contract`, `invoice`, `receipt`, `certificate`, `medical`, `financial`, `manual`, `letter`, `other`.

### 3.3.13. Collection
A user-created, flat (non-nested) named set of documents. This is the "shared folders" feature of the
product: users organize documents into collections and share them.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| ownerId | uuid | |
| name | string | unique per owner among active |
| description | string? | |
| createdAt / updatedAt / deletedAt | | |

### 3.3.14. CollectionItem
`(collectionId, documentId)` unique; `addedAt`, `addedById`. Hard-deleted on removal. Adding requires
read access to the document at add time; items whose document later becomes inaccessible to a viewer
are filtered out at read time for that viewer (the collection owner's access governs nothing for other
viewers — each viewer sees the intersection of the collection and their own access, **except**
documents with no library file, which are readable via the share itself, see 08 §8.5).

### 3.3.15. CollectionShare
| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| collectionId | uuid | |
| granteeUserId | uuid? | `NULL` = shared with the whole instance |
| createdAt / revokedAt? | | |

Unique active share per (collectionId, granteeUserId), including the NULL (instance-wide) row.
Sharing grants **read** access to the collection and, through it, to the documents in it that their
owner created. A document with a file on a library volume is never made accessible via a share —
library visibility is the only gate for it (deliberate: admins control library exposure, users
cannot widen it).

### 3.3.16. File

The bytes themselves, once, however many places they turn up in. A file is what a person put on the
volume or sent from their browser; it is never what they read. What they read is a document
(§3.3.10), which is an ordered list of files plus everything a machine and a person said about them.

| Field | Type | Notes |
|-------|------|-------|
| id | uuid | |
| contentHash | string | sha256 hex; unique among live files — the deduplication key that used to sit on the document (ADR-009, ADR-021) |
| origin | FileOrigin | `LIBRARY` (bytes on the read-only volume, addressed by `FileRef`s) or `MANAGED` (bytes in our bucket) |
| storageKey | string? | for `MANAGED` files, the exact object key; `NULL` for `LIBRARY` files. Stored rather than derived so a key written by an older version keeps working after the layout changes (docs/09 §9.2) |
| mimeType | string | detected from content (magic bytes), never from the extension |
| ext | string | lower-cased original extension |
| sizeBytes | bigint | |
| name | string | the file's own name, as it arrived: the last path segment, or the uploaded file name |
| crop | json? | the quadrilateral of this file's content, normalized to `0…1` of the image: `{ points: [[x,y] ×4] }` in the order top-left, top-right, bottom-right, bottom-left. Only meaningful for images; applied when the canonical PDF is built (§5.5) |
| cropSource | ValueSource | `NONE` (uncropped), `AUTO` (found by edge detection), `MANUAL` (a person dragged the corners). `MANUAL` is never overwritten by a rebuild |
| pageOrder | json? | the order this file's pages are read in: an array of its **0-based** page indices, each exactly once. `NULL` is the order they arrived in. Only meaningful for PDFs, exactly as `crop` is only meaningful for images; applied when the canonical PDF is built (§5.5 step 1.1) |
| pageCount | int? | how many pages this file has, counted afresh every time the canonical build reads it (§5.5 step 1.1). `NULL` until one has. This is what a `pageOrder` is checked against, so an edit can refuse a wrong permutation without a round trip to Stirling |
| trashedAt | timestamptz? | in the trash since (`05 §5.7a`): the file has left every document and is waiting to be deleted or restored. `NULL` for a file that is part of one |
| trashedReason | TrashReason? | why it left: `REPLACED` by a better copy, or `DOCUMENT_DELETED` with the document it was part of |
| trashedFrom | string? | the title the document had when the file left it — a record, not a link: that document is usually gone, and "which paper was this a page of" is the question somebody looking at the trash actually asks |
| replacedById | uuid? | for `REPLACED`: the file that took this one's place. Every earlier version of a page points at the file that is in the document **now**, not at the one immediately after it, so "the versions of this page" is one query and stays one however many times the page is replaced; the order among them is `trashedAt` |
| createdAt / updatedAt / deletedAt | | |

**Invariants:**
- One live file per `contentHash` — the same bytes arriving twice, from a scan and from a browser,
  are one file with two homes.
- A `LIBRARY` file has ≥0 `FileRef`s (0 once every copy of it has vanished from every volume, §5.7);
  a `MANAGED` file has a `storageKey` and no `FileRef`s.
- 🔒 A file belongs to **exactly one live document** (§3.3.17), **or is in the trash** (`05 §5.7a`).
  Detaching it from a document gives it a document of its own rather than leaving it homeless — so a
  file on a volume is always somewhere, and a scan that finds it again has nothing to guess. The
  trash is the second answer to "where does this file belong", added because "it was replaced by a
  better scan" is not "it is a document of its own": it is not a paper anybody wants to find, and a
  document per discarded page would fill the archive with them. It is still an answer, and ingest
  reads it as one (`05 §5.3`).
- A file in the trash has no `DocumentFile` row, keeps its bytes, and is what the trash screen lists.
  Restoring it makes a **new** document (`05 §5.7a`); emptying the trash is the one place a file row
  is deleted outright.
- Bytes are never modified. A crop and a page order are numbers written beside a file, not changes
  to it: the original stays exactly as it arrived and the canonical PDF is rebuilt instead (§5.6).

**The pages inside one file.** A duplex scanner interleaves them, a phone app appends the page that
was rescanned, a batch lands back to front. Until `pageOrder` existed the smallest thing anybody
could put in order was a whole file (§3.3.17), and the only cure for a shuffled PDF was to scan it
again. The order is written beside the file exactly as a crop is, and 🔒 **the original bytes are
never rewritten**: a `LIBRARY` file lies on a volume mounted read-only
([ADR-007](./02-architecture-overview.md#adr-007-external-library--read-only-volume-scheduled-scanning)),
and a `MANAGED` original stays the original somebody uploaded, so the order is an instruction the
canonical build reads (§5.5 step 1.1) and never an edit to a file. Which is also why clearing it
restores what arrived, whole and unaltered: there was nothing to undo.

The permutation is checked against `pageCount` — every build counts the pages of every PDF it opens
and writes the number down — so what a file holds is known at edit time without asking Stirling, and
a file no build has read yet takes no order at all rather than one nothing can verify (`07 §7.3`).

### 3.3.17. DocumentFile

The join that makes a document a sequence rather than a bag: `(documentId, position)` unique,
`fileId` unique among live rows (a file has one home, §3.3.16). Position is 0-based and contiguous;
reordering rewrites positions. Adding, removing, reordering or re-cropping a row — or reordering the
pages inside the file a row points at (§3.3.16) — invalidates the document's canonical PDF and
enqueues a rebuild (§5.6).

### 3.3.23. DocumentLink

Two documents that belong together and are still two documents: the act beside its contract, the
receipt beside the act (ADR-023). A document is one paper (§3.3.10) and combine is for the files of
*one* paper — a link is how separate papers about one matter point at each other without becoming
pages of each other.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| aId / bId | uuid | the two documents, stored as an **unordered pair**: `aId < bId` always (application-enforced, checked in SQL), so one edge cannot exist twice in two spellings |
| createdById | uuid? | the person who confirmed it; links are never machine-made (ADR-023) |
| createdAt | timestamptz | |

**Invariants:**
- A link is undirected and untyped: "these two belong together", nothing more. A vocabulary of link
  kinds is deferred exactly as person roles are (§3.3.19).
- `aId ≠ bId`; one live edge per pair (`unique (aId, bId)` with the ordering above).
- **Hard-deleted on removal**, like a `CollectionItem`: an edge is a record of a present fact, not
  history — the journal is where "was linked, then unlinked" lives, as `LINKED`/`UNLINKED` entries
  written on **both** documents (§3.3.18).
- A hard-deleted document takes its edges with it (DB cascade, §3.3.10). A **soft**-deleted one — a
  document absorbed by combine — keeps them on the row that went away, invisible with it: the read
  rule below already filters them, and a record of where files came from keeps its record of what it
  stood beside.
- 🔒 **A link is visible only where both ends are.** Listing a document's links filters the other
  side through `canReadDocument` (§3.4) — a title leaking through an edge would be a smaller version
  of the leak the collection-item rule already refuses (§3.3.14). Creating one requires
  `canEditDocumentMeta` on the document being edited and `canReadDocument` on the other; removing —
  `canEditDocumentMeta` on either end, because an edge belongs to both.

The pipeline proposes candidates — documents that visibly cite each other's identifiers — and a
person confirms or dismisses (05 §5.6b). Nothing about a suggestion is stored, in either direction.

## 3.4. Access model (authoritative summary)

Full rules in [`08 §8.5`](./08-auth-and-authorization.md); the model in one place:

```
canReadDocument(user, doc):
  if user.role == ADMIN                → true
  if doc.deletedAt                     → false (404)
  → ANY file of doc is a LIBRARY file with an active FileRef in an active library L where
        L.visibility == ALL_USERS or LibraryAccess(L, user) exists
    or doc.createdById == user.id
    or doc has NO library file at all, and is an item of an active collection C where
         C.ownerId == doc.createdById                      — a share carries its owner's own work
         and an active CollectionShare(C, user) or CollectionShare(C, NULL) exists

# 🔒 Both conditions on that last branch are load-bearing, and neither is decoration:
#   - no library file: a share never widens library visibility, which is the admin's to control
#     and not a user's to give away (§3.3.14).
#   - C.ownerId == doc.createdById (§3.3.15): without it, a document shared *with* somebody could
#     be added by them to a collection of their own and shared onwards, to a third party or to the
#     whole instance, with the creator neither asked nor able to see it. The plain
#     `C.ownerId == user.id` alternative this branch used to carry is not lost by the change — a
#     collection owner reading their own document is already covered by `doc.createdById == user.id`
#     above, since the two are now required to be the same person.

canEditDocumentMeta(user, doc):        # title, document type, the composition of files
  → canReadDocument via a library                 — collaborative editing
  → owner or ADMIN, for a document with no library file at all

# A document that absorbed an uploaded file into a library document stays readable to whoever the
# library is readable to: one visible file is enough, because the document is one thing.

canManageCollection(user, c):  c.ownerId == user.id or ADMIN
canReadCollection(user, c):    owner, ADMIN, or active share (user-specific or instance-wide)

linkDocuments(user, a, b):     canEditDocumentMeta(user, a) and canReadDocument(user, b)   # §3.3.23
unlinkDocuments(user, a, b):   canEditDocumentMeta(user, a) or canEditDocumentMeta(user, b)
# a listed link shows its other side only where canReadDocument holds for it — both ends, always
```

An `ApiToken` (§3.3.22) adds no rule to this table: it resolves to its owner and then every check
above runs unchanged — with one subtraction, that the caller may only read.

## 3.5. Deletion semantics (summary)

| Action | Effect |
|--------|--------|
| File gone from disk | `FileRef.MISSING`; the document turns `PARTIAL` or `UNAVAILABLE`; nothing is deleted, and the canonical PDF still reads |
| File detached from a document | the file becomes a document of its own, with its own canonical PDF; nothing is deleted (§5.6) |
| Document absorbed into another | its files move over in order, its own row is soft-deleted, and its collections/metadata are left behind with it (§5.6) |
| Library soft-deleted | its documents disappear from all listings; artifacts/data retained |
| Document deleted (admin) | **hard** (§3.3.10): the row, its journal, chunks, Markdown, collection items, people/subject links, document links (§3.3.23), `DocumentFile` rows and its artifacts are gone for good. Its files go to the **trash** (`05 §5.7a`) with `DOCUMENT_DELETED`; a `LIBRARY` file's `FileRef`s are kept `EXCLUDED` so the next scan does not ingest it again (§3.3.9) |
| File replaced in a document | the new bytes take the old file's position; the old file goes to the **trash** with `REPLACED` and `replacedById` pointing at the file now in its place (`05 §5.6`) |
| File in the trash | a `MANAGED` one is deleted with its object once it is older than `TRASH_RETENTION_DAYS`; a `LIBRARY` one waits for a person, because its bytes are on a read-only volume. Either can be deleted at once, or restored — which makes a **new** document (`05 §5.7a`) |
| Document type soft-deleted | documents' document type reset to NONE; their `extracted` values stay as a record (the schema is in the code, so they still render), and the next `fields` run skips `NO_SCHEMA` (§3.3.10a) |
| Collection soft-deleted | hidden for everyone incl. shares |
| User soft-deleted | sessions and API tokens revoked; their collections hidden; shares die with the collection, and the documents they created stay accessible to ADMIN only |

## 3.6. Open questions

None — previously open items are resolved in the corresponding documents (see 01 §1.7 note, 05 §5.9,
08 §8.7).
