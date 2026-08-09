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
          └── Document type (n:1)

EmailVerification (standalone, keyed by email; used by registration & password reset)
```

## 3.2. Enums

| Enum | Values | Notes |
|------|--------|-------|
| `UserRole` | `ADMIN`, `USER` | |
| `Language` | `EN`, `RU` | `EN` is the default |
| `Theme` | `SYSTEM`, `LIGHT`, `DARK` | |
| `LibraryVisibility` | `ALL_USERS`, `RESTRICTED` | new libraries default to `RESTRICTED` (fail-closed) |
| `FileRefStatus` | `DISCOVERED`, `HASHED`, `MISSING` | |
| `FileOrigin` | `LIBRARY`, `MANAGED` | where a file's bytes live: on the read-only volume (addressed by `FileRef`s) or in our own bucket (uploaded from a browser, or produced by us). A document's own origin is derived from its files rather than stored — see §3.3.10 |
| `StepStatus` | `PENDING`, `RUNNING`, `DONE`, `FAILED`, `SKIPPED` | per pipeline step. `RUNNING` is persisted, against the earlier decision to treat it as a queue state only: steps that take minutes exist — parsing with picture captions, OCR over a long scan, a local model thinking — and for those minutes `PENDING` reads as "stuck". The mark is best-effort and never the reason a job fails |
| `ValueSource` | `NONE`, `AUTO`, `MANUAL` | who decided a value: nobody, the pipeline, a person. Carried by `typeSource` and `titleSource` — one vocabulary, because it is one question |
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
now with one fewer place its bytes can be read from).

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
| searchVector | tsvector | generated from title + markdown (see 04) |
| canonicalStatus / previewStatus / markdownStatus / analysisStatus / vectorizationStatus | StepStatus | pipeline step statuses |
| processingError | string? | last error message (truncated to 2000 chars) |
| skipReasons | json | why a step is `SKIPPED`, per step — see below; empty for steps that ran |
| autoValues | json | what the pipeline decided — `{title?, description?, typeSlug?, languages?, country?, city?}` — kept beside the fields a person may correct, so the viewer can show "read as X" next to a hand-set Y. Merged per step, never erased by a correction |
| documentDate | date? | the date written on the document — signed, issued, departing. A date, not a timestamp: a signing has no clock, and midnight in some zone would invent a precision the paper does not have. Read by the analysis, editable |
| languages | string[] | BCP-47 tags of what the document is written in, most likely first — `['ru']`, `['ru','sr-Latn']`. Detected from the extracted text, editable; empty when there was too little text to tell |
| country | string? | ISO 3166-1 alpha-2 of where the document belongs — the issuer's country, the place of an event |
| city | string? | free text, as written in the document |
| failedStep | string? | which step produced `processingError` |
| ocrUsed | bool | whether Markdown came from OCR |
| titleSource | ValueSource | default `NONE` — the file name is not a choice; `MANUAL` is never overwritten by auto |
| typeId | uuid? | |
| typeSource | ValueSource | default `NONE`; `MANUAL` is never overwritten by auto |
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

**Skip reasons.** `SKIPPED` on its own reads like something went wrong, and three of the five steps
skip for reasons an operator can act on. Each skipped step records why, from a closed set:

| Reason | Meaning |
|---|---|
| `NOT_NEEDED` | nothing to do for this document — no file of it is an image, so there is nothing to crop |
| `UNSUPPORTED_FORMAT` | the format has no representation the product can build |
| `NOT_CONFIGURED` | the instance has no classifier / embeddings provider (docs/05 §5.5) |
| `NO_TYPES` | retained for documents processed before step 4 became a full analysis; no longer produced — with no document types defined the step still runs, because it also reads where the document is from |
| `NO_TEXT` | the document yielded no text to embed |
| `MANUAL_TYPE` | a person chose the document type, and a machine never overwrites that |

**Derived state (computed, not stored):**
- `origin`: `LIBRARY` when at least one of the document's files is a library file, `MANAGED`
  otherwise. Not a column — a document that absorbs an upload does not change kind, it gains a file.
- `availability`: `AVAILABLE` when every file of the document can be read right now; `PARTIAL` when
  some can and some cannot; `UNAVAILABLE` when none can. A `MANAGED` file is always readable — the
  bucket is ours and does not go missing behind our back — so only library files move this needle.
  **The canonical PDF outlives all of them**: a document whose volume was unplugged still reads,
  still searches and still downloads as a PDF, and says plainly that its originals are elsewhere.
- `processing`: `true` while any step is `PENDING` or `RUNNING` and prerequisites are not `FAILED`.
- `fileCount`, `sizeBytes`: how many files the document is made of and what they weigh together.

**Invariants:**
- A live document has ≥1 file. Removing the last one is refused (`DOCUMENT_LAST_FILE`); a document
  is emptied by deleting it, not by taking its parts away one at a time.
- Deduplication is a property of files, not documents (§3.3.16): two documents may hold the same
  file no more than one may — a file has exactly one home.
- Soft delete of a document (admin) hides it everywhere, removes its chunks from search, detaches it
  from collections logically (items referencing it are hidden, not deleted), and takes its files
  with it — they are not silently re-homed. A library file whose document was deleted is **not**
  re-ingested by the next scan; the scan sees a live `FileRef` pointing at a live file and leaves it
  alone.

**Artifact keys (deterministic, no DB columns — see 09):**
`documents/{id}/canonical.pdf`, `documents/{id}/preview.jpg`, `documents/{id}/thumb.jpg`.
A document owns no source bytes of its own: those belong to its files
(`files/{fileId}/original.{ext}` for managed ones, a path on a volume for library ones).

### 3.3.19. Person

Who a document is about: the parties to a contract, the passenger on a ticket, the patient in a
report. A shared catalogue rather than names written on each document, so the same person on forty
documents is one row — and correcting a spelling corrects all forty.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | string | unique among living rows, case-insensitively |
| note | string? | whatever tells two people of the same name apart, in the owner's own words |
| createdAt / updatedAt / deletedAt | | soft delete (ADR-015): the links stay, only new documents stop being able to name them. 🔒 Enforced, not merely offered: `PATCH /api/documents/:id` refuses a deleted id with `PERSON_NOT_FOUND` rather than re-linking it. A document that already names one says so — the detail carries `deleted: true` for that entry, and the viewer strikes it through, because a link that survives a deletion is a record and has to read as one |

`DocumentPerson` links the two, many-to-many, **without a role**. A role — buyer, seller, payer — is
real and wanted, but what the roles *are* is not knowable yet, and a half-guessed vocabulary is worse
than none. Open question in §3.5.

**Who may do what.** Reading the catalogue and adding to it are open to anyone signed in, because the
analysis step adds names on its own and whoever corrects it must be able to add the one it missed
without waiting for an admin. Renaming and removing are an admin's: both reach across every document
that names the person.

**Merging.** The analysis reads a name as each document spells it, so one person arrives as three
rows. Merging folds them together: the **oldest row survives** — the one the archive has been calling
this person longest — takes the name that was chosen, receives every document link the others had
(with the duplicates a document that named two of them would otherwise get collapsed into one), and
the rest are soft-deleted. All of it in one transaction: a half-moved merge would leave documents
pointing at somebody nobody can see. The surviving name may not collide with a person who was not
part of the merge — that would be two people becoming one by accident.

**The analysis step fills it in.** The model is asked for the people a document is about, named as
the document names them; each name is matched against the catalogue case-insensitively and created
when it is missing. Creating is the point — an archive where the machine may only pick from what
somebody already typed would need somebody to type everything first. Fill-blanks-only, like the rest
of the analysis: a document that already names people is one where somebody has decided, so the
answer is recorded in `autoValues.people` and not applied.

### 3.3.20. Subject

What a document is *about*: a flat, a car, a country, a company. The **kind** says what sort of thing
it is, the **name** says which one — a lease is about *that* flat, a tax return about *that* country,
and "the papers for the car" is how anybody actually looks for them.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| kindId | uuid | which `SubjectKind` this is one of |
| name | string | which one, as the document writes it |
| note | string? | **how to recognise this one**: the address, the plate, the account number, the other party — whatever a document about it would mention. Written by hand, read by the analysis |
| createdAt / updatedAt / deletedAt | | soft delete (ADR-015): the links stay, and behave exactly as a deleted person's do (§3.3.19): refused on a new document, marked on an old one |

Unique on `(kindId, lower(name))` among living rows: the same flat entered twice is the failure this
table exists to prevent, and the kind is part of the identity because "Montenegro" the country and
"Montenegro" the boat are two things.

### 3.3.20a. SubjectKind

What sort of thing a subject is: `apartment`, `car`, `country`. A catalogue of its own, not a string
repeated on every row — renaming "flat" to "apartment" is then one edit rather than forty, the browse
screen has something to list, and the same kind cannot exist twice under two spellings.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | string | stored exactly as typed, in any language and any case; unique among living rows, case-insensitively |
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
creates the ones the catalogue has never seen, matching on `(kind, name)` case-insensitively; a
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
| key | string | primary key; `queue` is the first one — concurrency per queue, units inside a job, and which queues are paused |
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
| type | DocumentEventType | `CREATED`, `FILE_ATTACHED`, `FILE_MISSING`, `QUEUED`, `STEP_STARTED`, `STEP_FINISHED`, `META_CHANGED` |
| actorId | uuid? | who did it; **null is the pipeline acting on its own** |
| payload | json | what the entry needs to be readable: `step`, `status`, `reason`, `error`, `steps`, `source`, `path`, `changes` (field → `{from, to}`), and for a step: `service`, `endpoint`, `requestId` |
| at | timestamptz | |

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
| embedding | vector(1536) | pgvector; cosine ops |

Chunks are replaced wholesale on (re)vectorization: delete all → insert all (in one transaction).

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
| createdAt / updatedAt / deletedAt | | |

**Invariants:**
- One live file per `contentHash` — the same bytes arriving twice, from a scan and from a browser,
  are one file with two homes.
- A `LIBRARY` file has ≥0 `FileRef`s (0 once every copy of it has vanished from every volume, §5.7);
  a `MANAGED` file has a `storageKey` and no `FileRef`s.
- 🔒 A file belongs to **exactly one live document** (§3.3.17). Detaching it from one document gives
  it a document of its own rather than leaving it homeless — so a file on a volume is always
  somewhere, and a scan that finds it again has nothing to guess.
- Bytes are never modified. A crop is a number written beside a file, not a change to it: the
  original stays exactly as it arrived and the canonical PDF is rebuilt instead (§5.6).

### 3.3.17. DocumentFile

The join that makes a document a sequence rather than a bag: `(documentId, position)` unique,
`fileId` unique among live rows (a file has one home, §3.3.16). Position is 0-based and contiguous;
reordering rewrites positions. Adding, removing, reordering or re-cropping a row invalidates the
document's canonical PDF and enqueues a rebuild (§5.6).

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
| Document soft-deleted (admin) | hidden everywhere; chunks excluded from search; artifacts retained in S3 (cleaned by a later `maintenance` policy only if ever specified) |
| Document type soft-deleted | documents' document type reset to NONE |
| Collection soft-deleted | hidden for everyone incl. shares |
| User soft-deleted | sessions and API tokens revoked; their collections hidden; shares die with the collection, and the documents they created stay accessible to ADMIN only |

## 3.6. Open questions

None — previously open items are resolved in the corresponding documents (see 01 §1.7 note, 05 §5.9,
08 §8.7).
