# 11. UI/UX Specification

Screens, navigation, and states. Component names refer to Ant Design. Every screen supports the three
universal states: loading (skeletons), empty (illustration + hint + primary action), error (inline
retry). All texts via i18n keys (en/ru).

## 11.1. Shell & navigation

Authenticated layout: left **Sider** (collapsible) + content. Menu:

| Item | Route | Visible to |
|------|-------|-----------|
| Documents | `/documents` | all |
| Browse | `/browse/:libraryId` (submenu listing visible libraries) | all |
| Search | `/search` | all |
| Collections | `/collections` | all |
| Catalogues ▸ People / Subjects / Subject kinds / Document types | `/people`, `/subjects`, `/subject-kinds`, `/document-types` | all |
| Administration ▸ Libraries / Users / Queue | `/admin/*` | ADMIN |
| (footer) user name + role, Settings, Logout, version, collapse | `/settings` | all |

**The foot of the column**, bottom-last in that order: who is signed in — the name, and the role
where it is worth saying — then the two things they may do about it, then which build this is, then
the way to narrow the column. Pushed to the bottom rather than following the menu, so it sits still
while the menu grows. Collapsed, the name becomes an initial and the version goes: a truncated word
is not a name and a number nobody can read is not a version.

**The version** is read on the server from the package the image was built from, not from an
environment variable somebody has to remember to set — so the number on the screen and the tag on the
image cannot drift apart. Small and grey: nobody comes looking for it until something is wrong, and
then it is the first thing asked for.

🔒 **The control that narrows the column is the narrowest thing on it.** A hairline strip, not the
48px slab a component library offers by default — that was the loudest element in a column of quiet
type, spent on the least important decision on the screen (`§11.15`). It says what it is on hover and
on focus, and never before.

Top bar of content area: screen title, contextual actions, a global search input (submits to
`/search?q=`). **Not** the signed-in name: who you are travels with what you may do about it.

## 11.2. Auth screens

### Login (`/login`)
Centered card: email, password, Turnstile widget (when configured), submit. Errors inline
(`INVALID_CREDENTIALS` → "Invalid email or password", `RATE_LIMITED` → cooldown notice). Link
"Forgot password?" opens a static hint: "Ask your administrator for a reset link." If
`GET /api/auth/onboarding` says `required` → redirect to `/onboarding`.

### Onboarding (`/onboarding`), Invite (`/invite/[token]`), Reset (`/reset/[token]`)
The same **3-step wizard** (antd `Steps`):
1. **Email** — input (invite: pre-filled from `emailHint`, editable; reset: fixed masked email) +
   Turnstile → `register/start`. Always advances; shows "code sent" with a TTL countdown and a
   "resend" button (60 s cooldown).
2. **Code** — 6-digit one-time-code input, auto-submit on 6th digit → `register/verify`. Wrong code →
   shake + `EMAIL_CODE_INVALID`; burned → step back with `EMAIL_CODE_TOO_MANY_ATTEMPTS` notice.
3. **Password** — password + confirmation, strength hint (length 8–128, denylist) →
   `register/complete` → logged in, redirect to `/documents` (or `returnTo`).

Invalid/expired token pages show a dedicated state ("This invitation is no longer valid") — no wizard.
Onboarding when already onboarded → 404 page.

## 11.3. Documents (`/documents`) — the home screen

- **Grid of cards** (responsive, 2–6 columns): thumbnail (`/thumb`; file-type icon fallback while
  `previewStatus != DONE`), title (2-line ellipsis), a **file count** when the document is made of
  more than one ("7 files"), and status badges: `processing` (spinner tag "Processing"), `PARTIAL`
  ("Some files missing"), `UNAVAILABLE` (grey "Files missing").
- **What else a card says is chosen here** (a multi-select beside the order): the **file type**
  badge, the **document type**, the **date on the document**, the **people**, the **subjects**, the
  **place** and the **languages**. The extension and the document type are in that set rather than
  fixed, so both can be switched off: what you came for differs by archive, and somebody filing
  scans by person does not need to be told PDF forty times. The names are drawn as one line of
  secondary text each, cut off rather than wrapped, so a document naming eight people does not make
  a card eight rows taller; everything else is a tag. A field the document has no value for draws
  nothing at all.
  **The state badges are not in the set.** A card may say less about what a document *is*, never
  less about what is happening to it — hiding "Processing" or "Files missing" would be a card that
  lies by omission.
  **The choice lives in the URL** under the same rule as the order (`card=date,people`), and an
  empty value is a real choice — "title only" — which is why *absence*, not emptiness, is what means
  the default. It does not follow the person to another screen: **the four other screens that render
  this card — browse, a facet, a collection, the search results — keep the arrangement they have
  today** (`ext` + `type`), rather than inheriting a setting made here.
  `DocumentListDto` carries all of them on every row whether or not they are drawn (`07 §7.3`),
  fetched per page in the batched way the file counts already are — never one query per card.
- **Filter bar:** library select, document type select, availability toggle, "processing only" toggle,
  origin (All / From libraries / Added here). Filters reflect in the URL query.
  **The URL may carry more than the bar draws.** A name in a document's details pane is a link into
  this screen (`§11.5`), so `personId`, `subjectId`, `subjectKindId`, `year`, `country` and `city`
  arrive here without a control of their own. Every filter `GET /api/documents` takes is read out of
  the URL, and one with no control is carried through when another filter changes rather than being
  dropped by the first switch anybody touches — a link that only half works is worse than no link.
  **Clear filters** takes them off, because it clears what is in force rather than what is drawn.
- **Order** (a select beside the filter bar, not inside it): **Date on the document** (the default),
  **Date added**, **Last changed** — the three named orders of `GET /api/documents?sort=`
  (`07 §7.1`). The default arranges the shelf the way somebody keeps it rather than the way a machine
  filled it, and puts the documents **whose date nobody has read yet first**, because those are the
  ones still wanting attention. "Last changed" means the newest entry in the document's journal, of
  any kind (`03 §3.3.18`).
  **The choice lives in the URL**, beside the filters and under the same rule: a view can be linked,
  bookmarked and reloaded. It is deliberately *not* a filter — **Clear filters** leaves it alone,
  the empty state does not count it, and the suggestion cards above the grid still appear on an
  unfiltered shelf however it is arranged. The default leaves no trace in the query string, the way
  an unset filter does not, and a `?sort=` the contract does not know falls back to the default
  rather than being sent on. It does not follow the person to another screen — the four other
  screens that render this grid keep the order they have — and that is the accepted cost of putting
  it in the URL rather than in a profile.
- **Grouping** (a select beside the order): **none** (the default), by **document type**, **person**,
  **subject**, **year**, **country** or **city** — the dimensions of `GET /api/documents/groups`
  (`07 §7.3`). Choosing one draws the grid **as sections**: a heading with the group's label and
  **the real count from the server** — the archive's under the filters in force, not a header over
  whatever the current page happened to contain — and that group's cards beneath it. Grouping
  arranges the grid; it does not narrow it, so nothing is filtered by being looked at and leaving the
  grouping leaves the archive where it was.
  🔒 **A section for the documents the dimension cannot place**, last and outside the cap on how many
  groups are returned. `countByGroup` excludes nulls by construction, and without that section those
  documents would not be filtered out of view but silently absent from it — in an archive of 35 that
  is 9 with no type, 11 with no date, 17 with nobody named on them. Its contents are the ordinary
  list asked for what has no value in that dimension (`unassigned=`, `07 §7.3`).
  A document belonging to several groups — it names two people — is drawn in **each** of them, which
  was already true of the counts and becomes visible once they are headings.
  **Each section pages on its own**: one cursor cannot walk a grid whose order is two levels deep, so
  the count in a heading is the archive's while the cards under it are as many as have been asked
  for.
  Like the order, this is not a filter: it lives in the URL (`groupBy=person`), **Clear filters**
  leaves it alone, and a `groupBy` the contract does not know means no grouping rather than a request
  the API would refuse.
- **Selection → Combine.** The multi-select that used to build a scan set now says what it means:
  tick documents in page order and press **Combine into one document**. While the grid is picking,
  **the card is the target** — the whole of it, not the tick in its corner — and it stops being a
  link for as long as that lasts, so one gesture never means two things on one screen; a picked card
  is visibly picked from across the grid; and the keyboard reaches it the way it reaches the link it
  is the rest of the time, because a hit area only a mouse can use is half a fix. Their files move into the
  first-picked document in that order, the emptied documents go away, and the viewer opens on the
  result while it rebuilds (`05 §5.6`). Any documents can be combined, not only images.
- **"These look like one document."** Above the grid, at most three suggestion cards
  (`GET /api/documents/grouping-suggestions`, `05 §5.6a`): the thumbnails of the group, "7 scans in
  `passports/2026`, one after another", **Combine** and **Dismiss**. Dismissing is client-side and
  lasts the session — the server proposes, it never remembers being refused.
- Infinite scroll (`useInfiniteQuery`). Card click → viewer. Empty state (fresh instance): "No
  documents yet. Ask your administrator to add a library." — with a CTA to `/admin/libraries` for
  admins, and the upload affordance below, which any user can act on.
- **The whole screen takes a dropped file** — the heading, the filter bar, the empty space beside the
  cards, not only the grid. Nothing is drawn until a drag is actually in progress; then an overlay
  says so unmistakably and goes away the moment the drag ends, leaves the window or is abandoned. It
  takes no pointer events itself, because a surface that swallowed the pointer would end the drag it
  is announcing. Three details are behaviour, not decoration: the overlay survives the pointer
  crossing into a child element (the browser fires a leave for the parent, and a zone that believes
  it flickers — enters and leaves are counted in pairs instead); a drag carrying **no file** — text,
  a link, a selection — is ignored entirely rather than promising an upload that cannot happen; and
  the browser's own default for a file dropped on a page, which is to navigate away to it and lose
  what the person was looking at, is taken away wherever it would fire.
- **Upload** (header action, and the page-wide drop zone above) is **a queue on the page, not a modal
  over it**. The moment files are chosen they are cards in the grid — ahead of everything, since a
  file chosen a second ago is both the newest thing here and the thing being waited on — each marked
  `Waiting` and then `Uploading…`. They are sent to `POST /api/documents` **one at a time, in the
  order they were chosen**, however many there are: forty parallel uploads saturate the connection,
  arrive interleaved and make the processing queue jump about, while one at a time is barely slower
  and far easier to watch. Each placeholder is replaced by the real card as its document lands — the
  list is refreshed *before* the placeholder goes, so the card is replaced rather than blinking out
  and back in. Choosing more files **appends to the same queue** instead of starting a second one.
  A failure keeps its own card, wearing the reason — too large (`UPLOAD_MAX_BYTES`), or
  `DOCUMENT_DUPLICATE`, "this file is already on this instance", which is what deduplication means
  from the outside — and the queue carries on: one rejected file must not take the other thirty-nine
  with it. That card is dismissed by hand, because an error nobody saw is an error that did not
  happen.

## 11.4. Browse (`/browse/…`)

Browsing is by **what a document is about**, not only by where its bytes are — that is how a person
looks for a paper, and which folder on which disk it happens to sit in is the last thing they think
of. Each facet is two screens, folders then contents, and the contents are the same card grid the
documents screen uses, because a document should look the same wherever it is found:

| Address | Folders | Contents |
|---|---|---|
| `/browse/types` → `/browse/types/:id` | document types, with counts | documents of that type |
| `/browse/people` → `/browse/people/:id` | people | documents about that person |
| `/browse/subjects` → `/browse/subjects/:kind` → `/browse/subjects/:kind/:id` | kinds, then the things of that kind | documents about that thing |
| `/browse/years` → `/browse/years/:year` | the years documents carry, newest first | documents dated in that year |

Folders are a list, not cards: a folder is a word, and a word does not need a picture. The heading of
a contents page is resolved on the server, so it is right in the first paint rather than after a
fetch; a folder that does not exist answers 404, because a wrong address is not an empty shelf.

Counts are per facet value and come from the catalogue endpoints; the years come from
`GET /api/documents/years`, which is scoped by what the viewer may read — a year holding one document
they cannot see is not a year that exists for them.

## 11.4a. Browse a library (`/browse/:libraryId?path=`)

Folder-tree navigation over the library's real directory structure (any nesting):
**Breadcrumb** (`Library name / sub / folder`), folder list (name + document count), then a document
grid of that folder (same cards as 11.3). Clicking a folder descends; breadcrumb ascends. Missing
files show as unavailable cards. This is the primary "explore what got mounted" scenario.

## 11.5. Document viewer (`/documents/:id/:tab?`)

Tabs: `preview`, `text`, `log`, `details`.

The open tab is the last segment of the address — `/documents/:id/text` — so a link to a document can
be a link to its text, and a reload lands where it was left. `/documents/:id` opens the preview; an
unknown tab is a 404 rather than a guess.

Two-pane layout, with the **title above the tabs**: it names what is on the page, and a name is read
before the metadata of the thing it names.
- **Left (main): tabs** — `Preview` (**the canonical PDF** in an `<object>`, for every document
  whatever it is made of, because by the time it is readable it is a PDF (`05 §5.5`); while the step
  has not finished, the preview image if there is one and a "Being assembled…" panel if there is
  not), `Text` (rendered Markdown
  representation; empty state "No text extracted yet" / "Extraction failed" / "Being extracted…"
  while the step is `PENDING` or `RUNNING`). **The text is typeset, not merely rendered:** what the
  parser hands over is Markdown, and the browser's defaults make it a web page from 1996 — a heading
  shoved against the tab above it, a table collapsed to the width of its longest word, code the size
  of prose. It is set in the reading room's own rhythm instead: a measure of about 74 characters
  because an OCR'd page is long and prose past 80 loses the eye; headings with more air above than
  below, so a section reads as a section; no margin on the first or last block, since the pane
  already spaces itself; tables at the full width of the pane with real cell rules, a weighted
  header and a scroller of their own, because a fourteen-column invoice must widen nothing; code and
  quotations in the faces §11.15 gives them. Restrained on purpose — the document is the thing being
  read, and this is only how it is set, `Details` (metadata table: pages, size, created, OCR used,
  **languages** and **place**, plus the **Files** section of §11.5a). Everything a machine decided is **editable here and only here** —
  document type, languages, country, city — behind one **Edit** button (top right of the pane,
  or the **E** key; **Escape** leaves) that turns those rows into ordinary inputs, and **Save** at
  the bottom right that turns them back — rather than controls sitting in the page all the time:
  reading is the common case, and a page of live selects invites edits nobody meant to make. Every
  input is one width; a place is two inputs sharing that one width, because it is one fact. A field
  the pipeline read differently carries a **reset** next to it, which puts it back to what was read —
  travelling as a reset rather than as the same value typed in, so a reset document type becomes `AUTO`
  again instead of claiming somebody chose it. **People** is a multi-select over the catalogue with
  "Add «name»" for anything typed that is not in it yet — the analysis step creates people on its
  own, so a person correcting it must be able to do the same without an admin (03 §3.3.19).
  **Subject** works the same way, except that adding one takes both halves — the dropdown footer asks
  for the kind before it offers to add, because a name with no kind is not a thing anybody can file
  by (03 §3.3.20).
  **A kind is not an object, so the reading pane gives it a row of its own** — the kind, then the
  object — instead of one line reading "Njegoševa 5 · apartment", which is two facts run together and
  neither of them legible. Editing stays one control over subjects, because a subject *is* a kind plus
  a name and choosing the halves apart would let somebody choose a pair that is not a row; while the
  form is open the kind row simply follows what the select holds. **A kind is named once** however
  many things of it the document is about: two flats say "flat" once, because the row answers what
  sort of thing this is about and the row below answers which ones. When the kinds differ they are
  listed as a set — deliberately not paired off position by position against the objects, which is
  the running-together this split exists to end; each kind is still a way into everything of that
  kind, and each object into itself.
  **Every name in the pane is a way in.** The person, the subject, the kind, the document type, the
  date and the place each link to the documents filed under them, because a detail read on one
  document is how the next one is found. Where a facet already has a browse screen (`§11.4`) that is
  the destination — it resolves its own heading on the server and shows the same card grid: a type to
  `/browse/types/:id`, a person to `/browse/people/:id`, a subject to `/browse/subjects/:kind/:id`,
  the date to its year at `/browse/years/:year`. The two that have none go to the home screen with
  the filter in the URL, which is where filters live (`§11.3`): a **kind** to
  `/documents?subjectKindId=…`, since `/browse/subjects/:kind` lists the *things* of a kind and what
  is wanted here is the documents; and the **place**, which is two links rather than one — the city
  within its country (`?country=…&city=…`, because "Bar" is a town in three of them) and the country
  on its own (`?country=…`), because "everything from Montenegro" is a question people ask. A name
  the catalogue has let go is the exception and stays plain struck-through text: the browse screen
  resolves its heading from the live catalogue and answers 404 for a deleted row, so the link would
  lead nowhere. A record is not a way in.
  Save sends **only the fields that changed** — an untouched document type must not travel, or every save
  would flip `typeSource` to `MANUAL` and a classifier's choice would silently become a person's.
  Cancel drops the draft. What the machine decided is kept: when the two differ, a
  quiet grey line under the value says "read as …". A correction is then never a dead end, and the
  question "did it get this wrong, or did somebody change it?" has an answer on the page.
  **That line is also the way back.** Outside the form it is a control: one click puts the field back
  to what was read and saves it, with no edit session around it — reading "Language: English, read as
  Russian" and agreeing with the machine is one gesture, and opening a form to change a field to a
  value already printed on the page is a form nobody needed. It travels as the same `reset` the form's
  own button sends, never as the value typed in, so a document type goes back to `AUTO` rather than
  becoming somebody's choice. Only the fields a rerun could write carry it — a person or a subject
  the analysis named is a link, not a value, and `PATCH` has no reset for either. Inside the form the
  line stays plain text: the control next to the input is the reset there, and two of them would be
  two answers to the same question. Languages and the country are
  shown as names in the reader's own
  language (`Intl.DisplayNames`), not as the tags stored — "Serbian (Latin), Montenegro", not
  "sr-Latn, ME"; an em dash where nothing was detected, which is honest and never looks broken.
  **Editing them offers those same names.** Both pickers are searched by name rather than by code —
  a person adding Russian to a document types "Rus", not `ru`, because the code is a thing the
  machine needs and the name is the thing they know. The country picker lists every region `Intl` can
  name; the languages picker every language it can, plus whatever tags the document already carries.
  It still takes a typed tag for anything not on that list, because BCP-47 has more of them
  (`sr-Latn`) than a list worth shipping — but nobody should have to reach for that to say "Russian".
  **A field whose step has not settled carries that step's badge** — `RUNNING` or `PENDING`, the same
  words the processing panel uses — in place of the em dash, or in front of a value that is about to
  be rewritten. Which step owns which field follows the pipeline (05 §5.5): pages from the preview,
  text/languages/OCR from the parse, place and document type from the AI step. Nothing else gets a badge:
  size, type and hash are facts about the file, and no step will ever change them.
- **`Log`** — the document's history as a table — when, what happened, who — newest first
  (03 §3.3.18): added, queued, each
  step started and settled, what a person changed and from what. A failed step carries its message,
  because the log is where somebody goes when something went wrong; a skipped one carries its
  reason. Entries the pipeline wrote have no author — an em dash in the Who column, which is how
  "the machine did this" is said. A table rather than a timeline: a log is scanned for the one row
  that matters, and columns that line up are what makes scanning possible.
  **A settled step also says what it cost:** how long it took, and — where the step answers them —
  how many pages it worked over, how many characters came out, whether recognition ran, and what a
  model reported spending, beside the step they belong to (`03 §3.3.18`). Only the numbers that step
  actually reported: a missing one is not a zero.
  **A step also says who did the work:** the service it went to, and the id it was asked under, in
  monospace under the sentence — values to be copied into a `grep`, not read (03 §3.3.18). The same
  id is on the started and the finished entry, and on the request the service itself logged, so
  "analysis failed" stops being a dead end. An admin additionally sees the host, which nobody else
  can act on and nobody else is shown.
  Fetched only when the tab is open — most visits never ask.
- **Right (sidebar):** title (inline-editable when permitted), document type select (all users with
  access; shows "auto" tag when `typeSource=AUTO`), the **Download split button** of §11.5b,
  Add-to-collection select, processing status panel: five steps, one row each
  (`RUNNING` in the panel means the pipeline is on that step right now — the viewer polls every 5 s
  while the document is processing, so a long step shows its progress by moving on, not by a bar),
  laid out as a grid — select, state, name — so every name starts at the same x whatever width the
  status tag happens to have. What a step has to say about itself goes **under its own name**, in
  that same column: a `SKIPPED` step **always shows why** ("not needed for this file type", "no AI
  provider configured", and the rest of docs/03 §3.3.10), because the label alone reads as a failure
  to everyone who has not read the pipeline; a `FAILED` step shows its `processingError` there too,
  attached to the step that produced it rather than pooled at the bottom of the card where it names
  nothing. ADMIN gets a checkbox at the start of each row and one "Reprocess" button below — the
  step names are already on screen, so a second list of them to tick would be the same five words
  twice. An error the server could not attribute to any step still renders under the list.

## 11.5a. The Files section (Details tab)

A document is an ordered list of files (`03 §3.3.10`), and this is where that list is visible and
editable. One row per file, in page order: a thumbnail of the file, its name, kind and size, a
`MISSING` tag when the volume no longer has it, and the library path underneath when it has one —
where the bytes live is a fact about the file, and it belongs beside the file rather than in a
section of its own.

**Every file says where it is, not only the ones on a volume.** A managed file — an upload, or
something Legere made — has no library path, and used to say nothing at all here, which left a
document made of uploads looking like one with no whereabouts. It names **the object storage**, as
such, and the key its bytes are under (`09 §9.2`), in that same line under the file. 🔒 As text, in
the same monospace the library path uses, and **never as a link**: the key is a location and grants
nothing on its own — the bucket is private and only a signed URL reads it — so anything that looked
clickable would be a promise it will not keep. **Download** on the row is the way to the bytes, and
it is right there.

Per row: **Download** (this original alone), **Crop** for an image (§11.5c), **Move up / Move down**,
and **Split off** — which says plainly what it does, "this file becomes its own document", because
"remove" would promise a deletion that never happens (`05 §5.6`). Splitting off the only file is not
offered at all rather than refused after the fact. Above the list: **Add files**, the same upload
queue as the grid (§11.3) pointed at this document, appending in the order chosen.

Every one of these rebuilds the document — the canonical PDF, the preview, the text, the analysis —
so the section says so once, quietly, under its heading: "Changing the files rebuilds the document."
While that happens the rows stay usable and the document keeps showing what it had.

## 11.5b. Download: the document, or what it was made of

**Download** is a split button. Its main half hands over the **canonical PDF** — the document as one
piece, searchable, straightened, in page order — because that is what somebody asking for "the
document" means. Its dropdown lists the originals, one entry per file, named as they arrived, each
downloading exactly those bytes; a file the volume has lost is listed disabled with the reason.

The default is never silently the original: a document made of forty photographs downloads as one
PDF, and a person who wants photograph 23 asks for photograph 23. Until the canonical has been
built the main half is disabled with "Being assembled…", and the originals remain available
throughout — the dropdown is the answer to "I need the raw file", and it should work on the worst
day, when the pipeline is broken.

## 11.5c. The crop editor

Opened from a file row of §11.5a for an image. A modal over the image at the largest size that fits,
with **four draggable corner handles** joined by a polygon and the outside dimmed — a quadrilateral,
not a rectangle, because a page photographed at an angle is not a rectangle and forcing one either
cuts the corner off or keeps the table it is lying on.

- **Auto-detect corners** asks the server (`GET …/crop-suggestion`) and drops the answer into the
  editor for the person to accept or drag. It is a proposal and says so; it never saves by itself.
- **Reset** clears the crop entirely — the file goes back into the canonical whole.
- **Save** stores the quadrilateral and rebuilds the document; the modal closes on the answer, not
  on the click, so a failure is visible where it happened.
- Handles are draggable with a pointer and nudgeable with the arrow keys once focused (1 px, 10 px
  with Shift), because the last two pixels of a corner are not a mouse gesture.
- The preview inside the modal shows the source image as it is; the perspective correction happens
  when the canonical is built, and the modal says what the result will be ("the page will be
  straightened to a rectangle") rather than pretending to render it.

## 11.6. Search (`/search?q=`)

Search input + mode toggle (`Hybrid | Text | Semantic`; semantic disabled with a tooltip when
`semanticAvailable=false`), filter bar (library, document type). Results: list rows — thumbnail, title,
highlighted snippet (`<mark>`), document type, score-ordered. Empty query → recent documents. No results →
suggestions ("check spelling, try semantic mode").

## 11.7. Collections (`/collections`, `/collections/:id`)

- List: two groups — "My collections" and "Shared with me" (owner name shown). Create button → name
  dialog.
- Detail: header (name, description, inline-edit for owner), document grid (cards; owner sees a
  remove-from-collection action), **Share** button (owner): modal with a user autocomplete
  (`/api/users/lookup`), an "Everyone on this instance" switch, and the current share list with
  revoke buttons.
- Non-owner viewers see the intersection they're allowed to see; no edit affordances.

## 11.9. Settings (`/settings`)

Profile card: display name, email (read-only), language (English/Русский), theme
(System/Light/Dark). Changes save immediately (`PATCH /api/me`), language switch re-renders instantly
(cookie + reload of messages).

An admin also sees a line pointing at **Administration → Instance** (§11.13a): this page is about
the person, that one is about the server.

**Password card** ([`08 §8.1.6a`](./08-auth-and-authorization.md)): current password, new password,
and a repeat of the new one — the repeat is the client's own idea, since a typo in a string nobody
can read back is a lockout waiting to happen, and it never leaves the browser. The card says in one
line what changing the password does beyond changing it: everywhere else this account is signed in
gets signed out, and this browser stays. On success the fields clear and a toast names how many
other sessions ended; a wrong current password surfaces as `INVALID_CREDENTIALS` like any other
error. This card is *not* a way back in for somebody locked out — that is still an admin's reset
link (§11.2) — and the login screen says so rather than linking here.

**Sessions card** ([`08 §8.2`](./08-auth-and-authorization.md#82-server-side-sessions)): a table of
the browsers currently signed in as this user — device (the user agent, or "Unknown device" when
there is none, with a tag on the row that is asking), signed in, expires — and a **Sign out** button
per row behind a confirm popover. The confirmation for the current row says something different,
because it ends the session doing the asking; when it does, the server clears the cookie and the
screen goes to `/login` rather than sitting on a page that starts failing one request at a time.
Dead sessions are not listed at all: unlike a revoked API token, which is a record of something you
handed out, a revoked session is a browser that has already stopped mattering. It sits beside the
API tokens card because both answer one question — what is currently able to act as me — and both
are the user's own to revoke without an admin.

**API tokens card** ([`08 §8.2a`](./08-auth-and-authorization.md#82a-api-tokens-read-only)): a table
of the user's own tokens — name, status tag (Active/Expired/Revoked), created, expires, last used
("never" until it is used) — with a **Revoke** button per living row (confirm popover) and a
**Create token** button above. Creating opens a modal asking for a name and a lifetime in days
(default `API_TOKEN_TTL_DAYS`); on success the modal turns into the one and only sight of the token:
the string in a read-only field, a copy button, and a plain warning that closing the modal ends the
only chance to copy it. The card says in one line what a token is for — reading this instance from
outside, never writing — because a credential nobody can explain is a credential nobody should make.

## 11.10. Admin: Libraries (`/admin/libraries`, `/admin/libraries/:id`)

- Table: name, path, enabled switch, visibility, files/documents/missing counters, last scan (time +
  status), actions: Scan now, Edit, Delete (confirm modal warns content disappears from listings).
- **Create/Edit drawer:** name; **path picker** — a mini directory browser over
  `/api/admin/library-path-candidates` (starts at `LIBRARY_ROOT`, drill-down, select current folder);
  visibility radio (Restricted → user multi-select; All users); scan interval; exclude globs
  (tag input). Validation errors surface inline (`LIBRARY_PATH_INVALID`, `LIBRARY_PATH_CONFLICT`).
- Detail page: settings + **scan journal** table (started, duration, status, seen/new/changed/missing,
  error) and a live progress row while a scan runs.

## 11.11. Admin: Users (`/admin/users`)

Table: name, email, role tag, status (Active/Deactivated), created. Row actions: change role,
deactivate/reactivate (confirm; `LAST_ADMIN` errors as toast), revoke sessions, generate password
reset link (modal shows the URL once with a copy button and expiry). Header action **Invite user**:
modal (role select, optional email hint) → result modal with the invite URL (copy button, "shown only
once" warning) + the active invites list below the table with revoke actions.

## 11.12. Document types (`/document-types`)

Simple CRUD table: slug (immutable after create), name, description, documents count. Delete confirm
warns that documents will lose the document type.

## 11.12a. Catalogues (`/people`, `/subjects`, `/subject-kinds`, `/document-types`)

The three lists a document is filed by, each a table in the pattern of the document types: rows with
their counts, one modal that both creates and edits, and a delete behind a confirmation that says how
far it reaches. They exist because correcting a catalogue from inside a document is correcting it
through a keyhole — a name misspelled on forty documents is one row, and the screen that shows it as
one row is the screen where it gets fixed.

| Screen | Rows | Columns |
|---|---|---|
| `/people` | the people catalogue | name, note, documents |
| `/subjects` | the things documents are about | kind (filterable), name, note, documents |
| `/subject-kinds` | what sort of thing a subject may be | name, note, things, documents |

A subject's kind is a select over the catalogue, never a typed word: kinds are created where kinds
are managed (03 §3.3.20a). Moving a thing to another kind is an ordinary edit of that select — a boat
filed as a country is corrected, not deleted and retyped.

**Merging is what these screens are for.** The analysis reads a name as each document spells it, so
one flat arrives four times and one person three. Rows carry checkboxes; with two or more selected,
**Merge** asks the only question that matters — *which of these is the right name* — offering the
selected names and taking anything typed over them. For subjects it asks for the kind too, since the
selected rows may disagree. Everything then folds into one row and no document loses what it named.

**Nothing written on the merged rows is thrown away.** The dialog's note field arrives prefilled with
what the rows carried: the names that are about to disappear ("Also known as: …") and every note any
of them had, one per line. It is an ordinary editable field — a person deletes what is noise and
keeps what is not — but the default is "keep everything", because the alternative is a merge that
quietly destroys the one line somebody wrote a year ago to explain which flat this is.

**The documents count is a link**, to that person's or that thing's browse page: "40" is the question
"which forty?", and the answer is one click away. A count of zero is plain text — there is nothing to
go to.

**Deleting says what it costs.** A person or a subject stays on the documents that name it, and the
confirmation says so rather than implying the documents change. A kind that still holds things cannot
be deleted at all, and its confirmation says that too instead of offering a button the server will
refuse.

**And the document says it too.** On the viewer's Details a name the catalogue no longer holds is
**struck through**, with a tooltip saying it stays as a record — in the reading pane and in the
editor alike, where it is present, cannot be chosen again, and can still be taken off. Without that
mark the two states are indistinguishable: the link is meant to survive
([`03 §3.3.19`](./03-domain-model.md)), so "still filed under this name" and "filed under a name
nobody may use again" look identical, and the second is the one worth knowing about.

**These are content, not administration.** A catalogue is what documents are filed by, and the people
who file them are not necessarily the people who run the instance — so they live in the menu beside
Documents and Browse, and anyone signed in reads them and adds to them, exactly as the API has always
allowed. What is an admin's is what reaches across documents: renaming, deleting and merging. Those
affordances are simply not offered to anyone else — not a hidden screen, because somebody who cannot
rename a thing still needs to see the list and add to it. Document types are the one exception in the
other direction: reading is everybody's, but defining a type is an admin's, since the classifier and
saved filters are built on the list.

## 11.13. Admin: Queue (`/admin/queue`)

- **Queue depths** per job type: queued / active / recently failed, and the concurrency control of
  the throughput settings below.
- **Pipeline counters**, one row per step, one number per status. **Every number is a link**: it goes
  to `/documents?step=preview&stepStatus=FAILED` — the documents behind it. A counter nobody can act
  on is a number on a wall; the point of "12 failed previews" is the twelve documents.
- **Retry by step.** Beside a step's `FAILED` (and `PENDING`) count, a **Run again** action
  re-enqueues those documents for that step alone — the common repair after a container was down for
  an hour, done in one gesture instead of five hundred. It says how many it enqueued, and it is
  capped per call so a huge archive drains in batches rather than in one indigestible push.
- **Pause and resume.** Each queue carries a switch. Paused, it keeps taking jobs and runs none of
  them: the depth grows where an admin can see it, and nothing is lost. It is the honest way to stop
  one misbehaving step — OCR thrashing, a model answering nonsense — without stopping the instance.
  A paused queue is labelled as paused everywhere its depth is shown, so a growing queue is never
  mistaken for a stuck one.
- **Throughput settings:** per job type, how many run at once, and how many units inside one job do.
  Changes take effect without a restart and survive one (`05 §5.4`).
- **Failed jobs** table: queue, payload summary, error, when, retry count, and a per-row Retry.
- **Storage usage** as of the last maintenance run.

## 11.13a. Admin: Instance (`/admin/instance`)

What this server actually resolved its configuration to, read-only, grouped the way `12 §12.4`
groups it: core, database, storage, library, processing, AI, email, auth, queue. Each row is a name,
a value, and where the value came from — the environment, or the default nobody overrode. It answers
the questions an operator asks at 2 a.m. without shelling into a container: which database is this,
where does OCR go, which model is answering, is mail configured at all.

🔒 **No secret is ever a value here.** A password, an API key, an auth secret, a token: the row says
**Set** or **Not set** and nothing more, and `DATABASE_URL` is shown decomposed into host, port,
database and user — never as the string that carries its password. A page that leaks the credential
it is describing would be worse than no page.

A value that is not configured reads as **Not set** with the consequence beside it where there is
one — "AI analysis: not configured, the step is skipped" — because a blank is only useful next to
what it costs. The server does not write that sentence: it sends a `consequence` token
(`EMAIL_UNDELIVERABLE`, `ANALYSIS_SKIPPED_NO_PROVIDER`, …) and the page renders
`admin.instance.consequences.<TOKEN>` from the message catalog, so the explanation arrives in the
same language as the label above it.

## 11.14. Cross-cutting UI rules

- Destructive actions always confirm (`Popconfirm`/modal) and name the object.
- All times shown in the browser's local timezone, absolute on hover (tooltip with ISO).
- Copyable technical values (hash, URLs) use a copy-icon affordance with a "Copied" toast.
- Toasts for imperative successes are quiet (2 s); errors persist until dismissed.
- Keyboard: dialogs close on Esc; wizard advances on Enter; grid supports arrow-key focus (antd
  defaults suffice — no custom hotkey system in MVP).
- No dark-pattern empty states: when something is admin-gated, tell the user who can fix it.

## 11.15. Visual identity — "the reading room"

Legere is Latin for *to read*, and the product is a private archive: passports, contracts, invoices,
the scans of a life. The interface is built to feel like a well-kept reading room rather than a SaaS
dashboard — warm paper, ink, brass and verdigris, restraint in motion, and technical values set in a
monospace face because here they carry meaning (hashes, paths, sizes, ids) rather than decorate.

Everything below is expressed as antd theme tokens (`ConfigProvider`, `cssVar: true`) so components
inherit it instead of each screen inventing colours. **No hex literals in components** — a screen that
hardcodes `#fff` is a screen that turns white in dark mode.

### Palette

| Role | Paper (light) | Ink (dark) | Why |
|---|---|---|---|
| Page | `#F4F0E7` | `#141210` | Warm paper / warm black; neither is neutral grey |
| Surface | `#FFFDF8` | `#1C1917` | Cards, sider, header |
| Border | `#E3DBC9` | `#33302A` | Hairlines, never shadows-as-separators |
| Text | `#1E1B16` | `#EDE7DA` | Ink on paper, and back |
| Text secondary | `#6B6355` | `#A2998A` | |
| **Primary** | `#2F6B5E` | `#4E9A87` | Verdigris — a library green, far from antd blue and from error red |
| Accent | `#B7873A` | `#C89B4E` | Brass: highlights, the active shelf |
| Success | `#5F8D4E` | `#7CA96A` | Moss, distinct from primary |
| Warning | `#B7873A` | `#C89B4E` | Brass again — a warning is not a different world |
| Error | `#B23B3B` | `#E07070` | Warm red, still unmistakably an error |

### Type

- **IBM Plex Sans** — everything. Humanist, slightly technical, legible at 13–14 px. Headings are
  the same face, heavier and tighter. **No serif anywhere**: the display serif this spec used to
  name gave the shell a title-page voice, which reads as decoration in a product whose whole job is
  to show somebody else's documents — those are what should look like documents.
- **IBM Plex Mono** — hashes, file paths, sizes, ids, error payloads. These are values people compare
  character by character; proportional digits actively hurt.

Loaded through `next/font` so Next self-hosts them in the bundle: a self-hosted instance on a private
network must never call a font CDN at runtime.

### Surfaces, depth, motion

- Cards and panels: 1 px border in the **strong** border tone, radius 10, **no ambient shadow at
  rest**. Hover lifts 2 px, warms the border to primary, and adds one soft shadow — depth is an
  interaction, not a default. The border carries the whole separation, so it has to be seen: ~1.5:1
  against the page, not the ~1.2:1 a hairline gives. Hairlines are for divisions *inside* a surface —
  the rule under the wordmark, the line between a card's thumbnail and its body.
- Label–value pairs are a **definition list with a dotted leader**, not a two-column table: the pairs
  stay legible at any width, no column has to be agreed on, and the eye is carried across the gap
  instead of jumping it. A missing value is an em dash — a blank reads as a rendering bug. Figures
  are tabular so they line up under one another.
- A thumbnail lies in a **well** (`--legere-well`), a tone mixed from the container and the text and
  therefore distinct from both the page and the card. It must never be the page colour: a card whose
  thumbnail area matches the background loses its top edge and stops looking like an object at all.
- The page carries a faint procedural grain (inline SVG turbulence, ~3% opacity) so large empty areas
  read as paper rather than as a colour swatch.
- One orchestrated moment per screen: content rises 8 px and fades in, grid items staggered 40 ms
  apart. Everything else is 140 ms ease-out hover/focus. All of it collapses to nothing under
  `prefers-reduced-motion: reduce`.
- Focus is always visible: a 2 px primary ring at 2 px offset, never `outline: none`.

### Density

Content column caps at 1440 px with 24–32 px gutters; controls are 36 px high; the grid breathes at
16 px gaps. The sider is 240 px, the wordmark sits above a hairline rule, and collapsing it leaves the
monogram — an "L", not a truncated word.

## 11.16. Open questions

None.
