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
| Search | opens the overlay (§11.1a) rather than navigating; `/search` is the page behind it | all |
| Collections | `/collections` | all |
| Catalogues ▸ People / Subjects / Subject kinds / Document types | `/people`, `/subjects`, `/subject-kinds`, `/document-types` | all |
| Administration ▸ Libraries / Users / Queue / Trash / Instance | `/admin/*` | ADMIN |
| (footer) user name + role, Settings, Logout, version, collapse | `/settings` | all |

**Search is the one item that opens rather than goes.** It is in the menu because that is where
somebody looks for it; pressing it raises the overlay of §11.1a over whatever is on the screen.
`/search` remains a real screen at a real address, reached from the overlay and by its own URL
(§11.6).

**The foot of the column**, bottom-last in that order: who is signed in — the name, and the role
where it is worth saying — then the two things they may do about it, then which build this is, then
the way to narrow the column. Pushed to the bottom rather than following the menu, so it sits still
while the menu grows. Collapsed, the name becomes an initial and the version goes: a truncated word
is not a name and a number nobody can read is not a version.

🔒 **The column does not travel with the page.** It is the height of the window and stays there while
the content beside it scrolls, so its foot is on the screen at the bottom of a long grid as well as
at the top of it — "sits still while the menu grows" is worth nothing if the whole column leaves the
screen the moment somebody scrolls. A menu that outgrows the window scrolls **inside the column**,
which is the one place the scroll can go without taking the foot with it.

**The version** is read on the server from the package the image was built from, not from an
environment variable somebody has to remember to set — so the number on the screen and the tag on the
image cannot drift apart. Small and grey: nobody comes looking for it until something is wrong, and
then it is the first thing asked for.

🔒 **The control that narrows the column is the narrowest thing on it.** A hairline strip, not the
48px slab a component library offers by default — that was the loudest element in a column of quiet
type, spent on the least important decision on the screen (`§11.15`). It says what it is on hover and
on focus, and never before.

🔒 **There is no bar across the top of the content, on any screen.** The authenticated shell is the
column and the content, and nothing else. What used to sit up there was a screen title, a contextual
action or two and a search input, and each was wrong in its own way. The **title** repeated either
the menu item already highlighted a few pixels to its left or the heading the screen drew for itself
immediately underneath, and the same name twice on one screen is not emphasis. The **actions** were a
long way from what they acted on — Upload above a grid it had nothing to do with, Invite user above a
table of users it does not appear in — and each now sits in the block it belongs to (§11.3, §11.11).
The **search input** was a field occupying the widest strip of the application at all times to answer
a question nobody had asked yet; it is raised on demand and centred instead, which is where a search
belongs while it is being typed (§11.1a). What the bar cost was the top of every screen, in the one
product whose whole job is to show somebody else's documents at the size they were photographed.

Each screen therefore owns its heading, inside its own content and **only where one earns its place**:
a collection names itself because its name is a thing somebody chose (§11.7), the trash says what it
is holding because that number is the reason to be there (§11.13b). A screen whose content already
says what it is does not say it twice — the Files tab writes no heading under a tab labelled Files
(§11.5a), and the documents grid is the archive rather than a page about the archive.

**A press is answered before the server is.** Walking from one section to another draws the next
screen immediately: the column stays exactly where it is, because it belongs to the layout and not to
the page, and the content beside it becomes a skeleton in the shape of a screen — a heading, and the
field of cards this archive mostly is — which is the universal loading state this document asks for
in its first line. Never a spinner, and never the previous screen frozen with the old address still
in the bar while somebody presses the link a second time. 🔒 **A skeleton is for arriving at a
screen, not for moving about inside one.** The viewer changes its own address as its tabs are pressed
(§11.5) without ever leaving the document; drawing a skeleton over that would take the page away from
the person reading it in order to announce that the page they are reading is on its way. Where the
boundary may live so that this cannot happen is [`10 §10.2`](./10-frontend-architecture.md#102-routing-map)'s
to say, and it says it as an invariant.

## 11.1a. The search overlay

Search is raised over what is open rather than navigated to. The question "where is that lease"
arrives while something else is on the screen, and the answer is usually one document rather than a
page of results to be worked through — so the menu item and **Cmd+K** (**Ctrl+K** where there is no
Cmd) both open a centred overlay over the current screen, dimming it instead of replacing it. The
hotkey works **anywhere in the authenticated application** and belongs to the desktop; the menu item
is how everybody else reaches the same thing, because a feature whose only door is a chord is a
feature most people never find.

One input, focused the moment it appears, and results **as the query is typed** — debounced, so a
word being typed costs one request rather than six. It is the same `GET /api/search` the page runs,
in the same default `hybrid` mode ([`07 §7.3`](./07-api-specification.md)): this is a faster way to
the one instrument and never a second, quieter search with its own opinion about what matches. A
short list of the top results, each row the anatomy §11.6 already fixes — thumbnail, title, the
highlighted snippet, the document type — because a result should look the same wherever it is read.

**The whole path is the keyboard's.** ↑ and ↓ move through the results and the highlighted row is
visibly the highlighted one; **Enter** opens it; **Enter with nothing highlighted** goes to
`/search?q=` carrying what has been typed, which is also what the **All results** row at the foot of
the list does — it is there for the pointer, and for everyone who never learns that Enter already
did it. **Escape** closes the overlay, and 🔒 **focus returns where it came from** — the card, the
menu item, the tab it was on — because an overlay that dissolves and drops the focus ring on the
document body has silently ended a keyboard session that had not finished. Closing changes nothing
underneath: that screen was dimmed, not left.

**An empty query is not an empty overlay.** It shows the **recent documents**, which is exactly what
the search page's own empty state shows (§11.6): one behaviour, described once, because two screens
answering "nothing typed yet" differently would be two products. Nothing found says so and says what
to try, in the words §11.6 uses.

Localized ru/en like everything else, and the shortcut is written where it is offered — the menu item
carries the chord as a hint on its right, since a shortcut nobody is told about is a shortcut for the
person who wrote it.

## 11.2. Auth screens

### Login (`/login`)
Centered card: email, password, Turnstile widget (when configured — see below), submit. Errors inline
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

**The Turnstile widget, when configured.** Both screens render it themselves: the Cloudflare script
is loaded once per page, the widget draws in the space the two forms leave for it, and the token it
hands back rides on the request the button sends
([`08 §8.4`](./08-auth-and-authorization.md#84-csrf-rate-limiting-captcha)). Until a token is in
hand the submit button of that step is **disabled** — the challenge is a step of the form rather
than a rejection after the fact, and the person is not sent round a login they had no way to pass.
An instance built without `NEXT_PUBLIC_TURNSTILE_SITE_KEY` renders no widget, keeps no space for one
and disables nothing: the screens look exactly as they do today.

## 11.3. Documents (`/documents`) — the home screen

- **Grid of cards**, sized by the width it actually has rather than by the window: as many ~220 px
  columns as fit the container (so the upload panel taking its third costs columns, not card width),
  and two abreast on a phone: thumbnail (`/thumb`; file-type icon fallback while
  `previewStatus != DONE`), title (2-line ellipsis), a **file count** when the document is made of
  more than one ("7 files"), and status badges: `processing` (spinner tag "Processing"), `PARTIAL`
  ("Some files missing"), `UNAVAILABLE` (grey "Files missing").
- **What else a card says is chosen here** (a multi-select beside the order): the **file type**
  badge, the **document type**, the **date on the document**, the **people**, the **subjects**, the
  **place**, the **languages** and the **extracted fields**. The extension and the document type are
  in that set rather than
  fixed, so both can be switched off: what you came for differs by archive, and somebody filing
  scans by person does not need to be told PDF forty times. The names are drawn as one line of
  secondary text each, cut off rather than wrapped, so a document naming eight people does not make
  a card eight rows taller; everything else is a tag. A field the document has no value for draws
  nothing at all.
  **The extracted fields are one such line**: the summary values of the document's field schema
  (`03 §3.3.10a`) in schema order, formatted for the reader's locale — "Voli · 12,40 EUR ·
  12.05.2026" on a receipt, a number and an expiry on a passport — separated by middle dots, cut off
  rather than wrapped like the names above. Formatting is the client's, from the registry it ships
  (`extractedSummary` on the row travels as stored values, `07 §7.3`); a document whose type carries
  no schema, or whose fields are empty, draws nothing at all, so the option costs nothing on the
  shelves it does not serve.
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
- **Order** (a select beside the filter bar, not inside it): **Date on the document**, **Date added**,
  **Last changed** — the three named orders of `GET /api/documents?sort=` (`07 §7.1`).
  **This screen opens in the contract's default and keeps none of its own**, so which order that is
  is written down once, in `07 §7.3`, and the two documents cannot drift apart over it. The
  reasoning is the screen's, though: what somebody arriving at their own archive asks is *what came
  in since I was last here*, and the date written on the paper cannot answer it — a receipt from
  2019 scanned this morning is the newest thing here and the oldest thing on the shelf. Arranging by
  the date on the paper is the right answer for *reading* a shelf, and it is one select away.
  "Last changed" means the newest entry in the document's journal, of any kind (`03 §3.3.18`).
  **The choice lives in the URL**, beside the filters and under the same rule: a view can be linked,
  bookmarked and reloaded. It is deliberately *not* a filter — **Clear filters** leaves it alone,
  the empty state does not count it, and the suggestion cards above the grid still appear on an
  unfiltered shelf however it is arranged. The default leaves no trace in the query string, the way
  an unset filter does not — so it is the date on the document that travels there now, and the date
  added that does not — and a `?sort=` the contract does not know falls back to the default rather
  than being sent on. It does not follow the person to another screen — the four other screens that
  render this grid keep the order they have, which each of them therefore asks for **by name**
  instead of inheriting the list's default: an order belongs to a screen, not to a person, and a
  screen that inherits one changes under it the day the default moves. That is the accepted cost of
  putting the choice in the URL rather than in a profile.
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
  **A heading folds its section**, which is what a heading is for: grouped by person, a grid drawn
  with every section open at once is a scroll nobody can see the shape of. **Collapse all** and
  **Expand all** stand over the grid, and the section for what the dimension cannot place folds like
  any other. **The real count from the server stays on a folded heading** — a folded section is an
  index line, not a hidden one — and a folded section **asks the server for nothing** until it is
  opened, which is the one thing a grid that pages per section gets in return for paging per section.
  🔒 **Folding is not a filter either.** It narrows nothing, **Clear filters** leaves it alone, and
  it is deliberately **not** in the URL, where a dozen folded groups make a link nobody can read. It
  is client-side and lasts the **tab**: `window.sessionStorage`, the way the dismissed suggestions of
  §11.5e already are, keyed by the grouping dimension and the group's own value. So walking into a
  document and pressing Back finds the grid as it was left, and a group folded under `groupBy=person`
  is still folded once the filters change — what was folded is the group, not the page.
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
- **Upload** stands at the end of the row of controls carrying the order and the grouping, and not
  among the filters: it is the one control on this screen that *makes* something rather than
  narrowing what is already there, and a button that adds documents has no business in a bar whose
  every other control takes them away. It, and the page-wide drop zone above, hand the chosen files
  to **the upload
  panel** (§11.3a) and change nothing else on this screen except its width — the grid narrows to the
  column the panel leaves it and reflows into fewer cards per row. They are sent to
  `POST /api/documents` **one at a time, in the order they were chosen**, however many there are:
  forty parallel uploads saturate the connection, arrive interleaved and make the processing queue
  jump about, while one at a time is barely slower and far easier to watch. Choosing more files
  **appends to the same queue** instead of starting a second one, and a file that fails takes none of
  the others with it.
  **Nothing stands in the grid for a file that is not a document yet.** The grid used to open with a
  grey placeholder card per queued file, ahead of everything; those are gone, and the grid holds real
  documents only. A document appears here the moment its upload lands — the list is refetched and the
  card falls where the order in force puts it, which is where it will still be after a reload — with a
  **brief highlight on the new card**, so the eye can carry from the row in the panel to the thing
  that just arrived. Grouped, it turns up under the heading it belongs to: a placeholder had no group
  to stand in, so a grouped grid used to show nothing whatever while forty files went up.

## 11.3a. The upload panel

**Where an upload is watched is not where it was started.** A column down the right-hand side of the
application, drawn by the application layout rather than by a screen
([`10 §10.5a`](./10-frontend-architecture.md)), so it outlives the navigation: starting forty files on
the documents screen and then opening one of them no longer abandons the other thirty-nine, which is
what a queue living in the grid could not help doing. It appears with the first file queued and goes
when the queue is empty; there is never more than one of it.

**It is part of the page, not something floating over it.** About a third of the viewport wide, and
the content beside it **narrows and reflows** to make room — the grid drops to fewer columns and gives
nothing up, rather than having a corner of itself covered by a panel that hides whatever happens to be
under it. Below `lg` there is no room for two columns, so it becomes a **full-width block above the
screen's content**, with a bounded height of its own; the order is the same as the layout's — what is
happening now, then what is being worked on.

🔒 **Its scroll is its own.** Sticky to the top of the viewport and down to the bottom of it — there
is nothing above it to hang from any more (§11.1) — scrolling inside itself: a queue of forty rows must not lengthen the page it sits beside, or reading
the grid would mean scrolling past the uploads and watching the uploads would mean losing the grid.

**One queue, and every way in feeds it.** Files dropped or chosen on the documents screen are
addressed to the library (`POST /api/documents`); files added on a document's Files tab are addressed
to that document (`POST /api/documents/:id/files`, §11.5a). Both queue behind whatever is already
going up, and go up one at a time in the order they were added.

**A file addressed to a document may also be addressed to a place in it.** Dropped on an insert point
of the page strip, it carries that position with it (`?at=`, §11.5a) — which is how a photograph goes
between page two and page three rather than after page five. The panel draws no such row differently:
where a file lands is the document's business, and the panel's is whether the bytes arrived. Several
files sent to one position keep their order, each going in after the pages of the one before it —
the answer to every upload is the whole document (`07 §7.3`), so the next position is measured
against the list the last one produced rather than against the list that was on the screen when they
were dropped.

🔒 **The position and the page it goes before travel together, or neither does.** What the second
file of a batch is re-measured against is the **page** the first one had to precede — an id, which
does not move however far the insert pushed it — and at the **last** insert point there is no such
page. A batch addressed there therefore carries no position at all and is a plain append, which is
what the server computes for itself inside the transaction that writes it. Sending the position
anyway is the bug this rule exists to close: with nothing to re-measure against, every file of the
batch carries the same number, each lands ahead of the one before it, and three files dropped at the
end of a document arrive in reverse. It is also the only answer that stays right while somebody else
is adding pages to the same document.

**One row per file, and the rows never move.** They are listed in the order they were added and stay
there whatever happens to them; what changes is the state of the row, in place, so somebody who found
their file in a list of forty goes on looking at the same line. Every row is **one and the same
height in every state** — the bar, the badge and the retry button all measure differently, and a
column whose rows breathe as files settle reads as jumping:

- **queued** — a clock, the name and the size. Nothing has been sent yet, and the row says so rather
  than showing a bar sitting at zero.
- **uploading** — the bytes that have actually left the browser, as a bar and a percentage of *that*
  file. Real progress rather than an animation waiting for an answer
  ([`10 §10.5a`](./10-frontend-architecture.md)).
- **uploaded** — a check in the success green; the document is in the grid beside the panel.
- **duplicate** — these bytes are already on this instance, and the server resolved the upload to the
  document that holds them (`200` rather than `201`, [`05 §5.1a`](./05-library-and-processing.md#51a-uploads)).
  That is not a failure and is not drawn as one: a quiet badge, and **a link to that document**,
  because "you already have this" is only useful beside which one. The other half of deduplication —
  bytes belonging to a document the uploader may not read (`409 DOCUMENT_DUPLICATE`) — has nothing to
  link to and stays a failure wearing its reason.
- **failed** — an error icon, the reason in a tooltip (a format the pipeline cannot render,
  `415 UNSUPPORTED_FORMAT` per [`05 §5.1a`](./05-library-and-processing.md#51a-uploads); too large,
  `UPLOAD_MAX_BYTES`; and the rest). The picker's `accept` already steers the file dialog to what is
  taken, but a drop cannot be filtered, so a dropped `.torrent` becomes a failed row wearing the
  refusal rather than a document.
  and a **retry** on the row itself. The reasons are sentences and the row is narrow, which is why the
  message is on hover rather than in the line; retry sends that one file again and the row stays where
  it is, since the list is the order things were added and not the order they were tried.

**The row being sent is kept in view**: a queue of forty is taller than the panel, and the one line
that is moving is the one worth seeing.

**The header counts files and measures bytes.** "Uploading 3 of 40" over a thin bar, and the bar is
**weighted by size rather than by file count** — the browser knows what each file weighs before it
sends a byte of it, so a queue of one 90 MB scan and thirty-nine small ones does not report itself
nearly done while the only slow thing in it has not begun. A settled file — uploaded, duplicate or
failed — counts its whole size; the one in flight counts what has actually gone.

**There is no folded state and no pill.** A panel that takes a third of the screen either has
something to say or should not be there, and the second is what closing it means: it goes away
entirely rather than shrinking into a badge somebody has to remember to open again.

**When everything has settled** the header says "40 uploaded" and the panel **stays where it is**:
it is the receipt for the run — which files arrived, which were already there, which did not make it
— and a receipt that takes itself away cannot be read. Closing it is the person's move, never the
panel's. A queue holding a failure additionally carries **Retry failed** in the header beside the
count.

**Closing it while files are in flight is a cancellation, and it asks first** (§11.14). Confirming
aborts the upload in flight, drops every row still waiting and empties the queue — the panel is the
queue's only window, so a ✕ that hid it while forty files carried on going up would be a control that
lies about what it did. What has already landed has landed; nothing uploaded is undone by it. With
everything settled there is nothing to cancel and the ✕ simply clears the list and hides the panel.

**The panel's responsibility ends at delivery.** It says whether the bytes arrived and nothing about
what happens to them next: the canonical, the preview, the text, the analysis and the vectors belong
to the pipeline, and they are already reported where they belong — the `processing` tag on the card
(§11.3) and the step panel in the viewer (§11.5). A panel that followed forty documents through five
steps each would be a second queue screen down the side of every page, and it would still be there an
hour later.

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

A contents page is arranged **by the date on the document**, and asks for that order by name rather
than taking whatever `GET /api/documents` defaults to (`07 §7.3`): everything about one person is
read the way a shelf is read, and a screen that inherits its order changes under its readers the day
another screen's default moves (`§11.3`). There is no control for it here — one order, chosen for
the screen.

Counts are per facet value and come from the catalogue endpoints; the years come from
`GET /api/documents/years`, which is scoped by what the viewer may read — a year holding one document
they cannot see is not a year that exists for them.

## 11.4a. Browse a library (`/browse/:libraryId?path=`)

Folder-tree navigation over the library's real directory structure (any nesting):
**Breadcrumb** (`Library name / sub / folder`), folder list (name + document count), then a document
grid of that folder (same cards as 11.3). Clicking a folder descends; breadcrumb ascends. Missing
files show as unavailable cards. This is the primary "explore what got mounted" scenario.

## 11.5. Document viewer (`/documents/:id/:tab?`)

Tabs: `preview`, `text`, `related`, `log`, `details`, `files`.

The open tab is the last segment of the address — `/documents/:id/text` — so a link to a document can
be a link to its text, and a reload lands where it was left. `/documents/:id` opens the preview; an
unknown tab is a 404 rather than a guess.

**Two-pane layout, and the main column begins with the tabs.** Nothing stands above them: the tabs
row is the one strip of chrome the document's own column spends, and the open tab takes the rest of
the height the viewport has. 🔒 **On opening a document the reader should see as much of the document
as the screen can give** — that is the whole purpose of the screen, and everything above the document
is charged to it on every page of every document, for a name that was read once on arrival. The
document's name is therefore not above it but **beside it**, at the head of the panel of things
*about* the document, which is where the rest of what is known about it already lives.

🔒 **And nothing around it either.** The main column is the tabs row and the document, drawn on the
page itself — no card, no border, no padding of its own. It is the argument above said in width
rather than in height: a frame around the whole zone is a frame drawn around the one thing the screen
exists to show, and it is charged a rule and a gutter on all four sides of every document. The panel
beside it keeps its cards, because those are objects laid on a page and this is the page.

**The height is taken, not merely wished for, and it is taken edge to edge.** Where the two panes
stand side by side, "the rest of the viewport" is literal to the pixel: 🔒 **this screen gives up the
page's vertical gutter** — the tabs row sits against the **top edge** of the window and the canonical
PDF runs to the **bottom edge** of it, with no 24px inset above or below. The gutter exists to keep
content off the edges of the window, and a document that scrolls inside its own viewer is not
content pressed against an edge: it is the only thing on the screen, and every row of pixels spent
framing it is a row of the document nobody can read. The horizontal gutter stays, because a page
flush with the left of the window is a page without a margin, which is a different thing entirely.
The panel beside it comes up level with the tabs rather than keeping a lonely inset of its own, and
keeps the gutter at its foot, since a card ending flush with the bottom edge reads as cut off where a
document ending there reads as continuing.

The page behind all this does not scroll at all. What is longer than the window scrolls **inside its
own pane** — the text of a forty-page scan, the log, the list of files — and so does the panel
beside it, so the tabs row and the panel both stay where they are while a document is read. Below
that width the viewer is one column above another and scrolls as an ordinary page, gutter and all: a
document pinned to the height of a phone would be a worse read, not a better one.
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
  read, and this is only how it is set, `Details` (below), `Files` (§11.5a).
  **The Details pane is three titled sections, in this order: What it says, What it is, What it
  cost.** They are three questions about one document and only the first of them has an answer
  anybody may correct. Until this they were one list — two rows nobody can edit at the head, every
  correctable row under them, added and OCR dropped at the foot, and a single **Edit** button
  floating at the top right of the whole pane, claiming rows it cannot touch. Which rows are readings
  off the paper and which are facts of the artifact was a thing the reader learned by pressing it.
  **What it says** is everything a machine read off the page: the document type, the people, the kind
  of thing and the thing itself, the document's own date, the page format, the languages, the place,
  and the typed fields of its schema. 🔒 **The Edit button stands in this section's own heading**,
  not above the pane — a control belongs over the rows it acts on and over no others — and what it
  opens is this section and nothing else: the two below it are not touched, and there is nothing in
  them to touch.
  **What it is** is the artifact rather than the reading: size, pages, added, OCR used. None of it is
  anybody's to correct, which is why it is a section and not a scattering of rows above and below a
  form — no step will ever be asked to read a file's size differently, and the pane should say which
  of its rows are of that kind without anybody having to press Edit to find out.
  **What it cost** is what the pipeline spent getting here, read by step rather than by moment: one
  row per step, naming what that step answered — how long it took, how many pages it worked over,
  how many characters came out, whether recognition ran, and what a model reported spending
  (`03 §3.3.18`). **The newest run only:** a step re-run three times has three entries in the journal
  and one truthful answer here. Only the numbers that step actually reported, because 🔒 **a missing
  number is not a zero — it means that step does not answer that question** (`03 §3.3.18`'s rule,
  word for word). A step that reported nothing at all has no row, and a document nothing has finished
  on yet has no section. The same numbers stand in the journal beside the moment they were spent (the
  `Log` tab below); this is them arranged by the question a reader asks about the *document* rather
  than about the log.
  **A step's row also carries what it thought of its own work**, in the same run of numbers and
  under the same rule: `legibility 20/100 · extraction 95/100` on the analysis, `confidence 78/100`
  on the fields (`03 §3.3.10`). Written as a mark out of a hundred rather than as a bare number,
  because `20` beside `3 pages` and `1200 characters` reads as a fourth measurement of the document
  and `20/100` reads as a score of the reading. It is drawn where the rest of what a step answered
  is drawn — this is the row about that step, and "how well did it go" belongs beside "how long did
  it take" — and 🔒 **nothing on the screen acts on it**: there is no button here that a low mark
  produces and no colour it turns, because a mark is what the model made of its own output and
  gating on it would be spending twice on a doubt the machine has about itself (`05 §5.5` step 4).
  Everything a machine decided is **editable here and only here** — document type, languages,
  country, city — behind that one **Edit** button (or the **E** key; **Escape** leaves) that turns
  the rows of **What it says** into ordinary inputs, and **Save** at the bottom right of that same
  section that turns them back — rather than controls sitting in the page all the time:
  reading is the common case, and a page of live selects invites edits nobody meant to make. Every
  input is one width; a place is two inputs sharing that one width, because it is one fact. A field
  the pipeline read differently carries a **reset** next to it, which puts it back to what was read —
  travelling as a reset rather than as the same value typed in, so a reset document type becomes `AUTO`
  again instead of claiming somebody chose it.
  **The typed fields close What it says, under the rows above** — a group per the document's field
  schema (`03 §3.3.10a`), one row per field, drawn only where the type carries a schema at all: the
  vendor, the total and the day of a receipt; the holder, the number and the expiry of a passport.
  Values are formatted for the reader (`Intl` dates and currency amounts), an em dash where nothing
  was read; a `table` field renders as a small table of its rows and is the one field the form does
  not edit — re-reading the document is how a table is corrected, and a row editor for receipt lines
  is a spreadsheet nobody asked for. Everything else follows the rules this pane already has: the
  scalar fields join the same **Edit** form as ordinary inputs (a `money` field is two inputs sharing
  one width, amount and currency, because it is one fact); a field the model read differently carries
  the same grey "read as …" line, which outside the form is the same one-click reset, travelling as
  `reset: ['fields.<key>']` rather than as a value typed in (`07 §7.3`); Save sends only the fields
  that changed, and a changed one becomes `MANUAL`, after which no run overwrites it. While the
  `fields` step has not settled, the group carries that step's badge exactly as the place carries the
  analysis's.
  🔒 **The page format is the one row here that is not a correction to a record**, and the form says so
  where it is being changed: a warning under the select — the pages keep the shape they have until the
  document is processed again — because the format is read while the pages are made (05 §5.5 step 1)
  and they are made already. It is a warning and not an action: a select that quietly remade forty
  pages, recognised their text afresh and replaced every artifact derived from them would be a rebuild
  nobody asked for, and reprocessing is asked for with the **Reprocess** button in the processing panel
  below. Shown only once the choice actually differs from what the document holds, so opening the form
  to change the city does not lecture about page shapes. **People** is a multi-select over the catalogue with
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
  be rewritten. Which step owns which field follows the pipeline (05 §5.5): the typed fields from the `fields` step, pages from the preview,
  text/languages/OCR from the parse, place and document type from the AI step. Nothing else gets a badge:
  size, type and hash are facts about the file, and no step will ever change them.
  🔒 **When the analysis judged this text incomplete, the text tab says so** — above the text, where
  it is read, rather than in a log somebody would have to think to open. A page this short on a
  document this full is the one thing a reader cannot tell by looking at what *is* there: the missing
  quarter of a lab report leaves nothing behind to notice. The verdict is `auto.textQuality`
  (`03 §3.3.10`), which until now was written down and read by nobody. Everybody sees the warning,
  because it is a fact about the document; only an admin is offered the re-read beside it, because
  that is a request to spend the pipeline.
  **And the warning carries the extraction mark beside its words** where the analysis gave one —
  `auto.quality.extraction`, the numeric refinement of that same verdict (`03 §3.3.10`) — because
  "some of this document was not read" is a different sentence at 81 out of 100 than at 12, and the
  reader deciding whether to bother with the re-read is exactly the person that difference is for.
  Where there is no mark the warning stands as it always did: 🔒 a missing mark is not a zero, and
  the words alone are the whole of what was said. The mark decides nothing about whether the
  warning appears — the three-word verdict does that, as it did before.
- **`Related`** — the documents this one belongs with, and the ones the archive thinks it might:
  see §11.5e.
- **`Log`** — what is being done to the document, and what has been done to it. **Two sections, in
  that order**, because they are one question asked twice: "is it finished, and did anything break"
  is answered by the first, "what happened" by the second, and the first used to stand in the
  sidebar of every document while the second was a tab away. Each carries its own heading —
  **Processing** and **History** — and neither repeats the word on the tab.
  **Processing** is the panel of `05 §5.5`: six steps, one row each, and each row reads the way
  every label-and-value pair in Legere already reads (§11.15) — a status glyph, the step's name, a
  dotted leader, and at the end of the line the state **in the reader's own words**, with the
  duration of the newest settled run beside it. A glyph and a word rather than the enum in a tag:
  `QUEUED` is schema vocabulary, and six identical grey pills of it were six repetitions of
  nothing. Each verdict keeps one shape and one colour — done, failed, running, queued, waiting,
  skipped — so the row that matters is found by shape before it is read, and the glyphs share one
  width, so every name starts at the same x. `RUNNING` is the only thing on the panel that moves
  (the viewer polls every 5 s while the document is processing, so a long step shows its progress
  by moving on, not by a bar). The duration is read off the newest `STEP_FINISHED` in the history
  this tab fetches anyway — one query serves both sections — and a step whose newest run reported
  no duration simply states its state. The same six words appear wherever a step status is written
  out, the pending badges of the Details pane included: one vocabulary for one fact.
  What a step has to say about itself goes **under its own name**: a `SKIPPED` step **always shows
  why** ("not needed for this file type", "no AI provider configured", and the rest of docs/03
  §3.3.10), because the glyph alone reads as a failure to everyone who has not read the pipeline;
  a `FAILED` step shows its `processingError` there too, attached to the step that produced it
  rather than pooled at the bottom where it names nothing. An error the server could not attribute
  to any step still renders under the list. A step the instance has **paused** (`05 §5.4d`) says so
  on its own row — a tag beside the name and, under it, the line that a step held by a pause is
  waiting on purpose and nothing is coming for it until somebody lifts it. Every reader sees all of
  this, not only an admin: "this document has been half processed for two days" is asked by
  whoever opened the document, and the honest answer is that a step was switched off rather than
  that the queue is slow.
  **The remedy stands beside the complaint it answers**, and only an admin is offered one, because
  each is a request to spend the pipeline: a `FAILED` step carries **Retry this step** under its
  own error; an analysis skipped for length alone carries **Analyse the whole document** beside
  the reason it names — the answer to a limit belongs where the limit is visible, and it is a
  different request from "run this again" (`05 §5.5` step 4).
  ADMIN's whole-panel controls stand in the section's head row, beside the heading: **Reprocess
  everything** — which is what the visit is for nearly every time — and a quiet **Choose steps…**
  next to it, which — and not before — is when a checkbox appears at the start of each row, the
  button starts naming the count it will send, and a Cancel stands beside it. Checkboxes at rest
  made the panel read as a form, when almost every visit is a
  glance at six states; a control drawn only while it is being used costs nothing the rest of the
  time. The step names are already on screen, so choosing ticks the rows themselves rather than a
  second list of the same six words — with a paused step **not selectable**, since a re-run of it
  is refused (`07 §7.3`) and a checkbox that buys a `409` is a checkbox that lies.
  **History** is the document's journal, newest first (03 §3.3.18), under **day headings** — today
  and yesterday by name, any other day by its date — each entry keeping a short time of its own in
  a gutter the eye can run down, and the full ISO timestamp on hover (§11.14): added, queued, what
  a person changed and from what, and what the pipeline made of each run. A journal rather than
  the flat table it used to be: two rows per step and a mostly-empty Who column made thirteen rows
  of what one entry can say, and what the reader scans for is the run that broke — grouping is
  what makes that scanning possible. **A run is one entry, not thirteen rows:** its `QUEUED` event
  opens it — who asked, and for which steps — and each step that ran folds its started and its
  settled event into **one line inside that entry**, in the order they ran, drawn in the same
  grammar as the panel above: glyph, name, leader, then the verdict and what the step cost — how
  long it took and, where the step answers them, how many pages it worked over, how many
  characters came out, whether recognition ran, what a model reported spending, and what it made
  of its own reading (`03 §3.3.18`). Only the numbers that step actually reported: a missing one
  is not a zero. The marks are drawn here exactly as they are in **What it cost** on the Details
  pane, because here they belong to *that* run of the step and there to the newest one, and the
  difference between two runs is a thing only the journal can show. A failed line carries its
  message under itself, because the log is where somebody goes when something went wrong — and a
  `FAILED` that arrived without one (a cascade downstream of the real failure writes no message)
  simply states its verdict. A started event whose settled half never came is told honestly:
  **running** while the pipeline is on that step now, **interrupted** otherwise — an outage severs
  pairs (`05 §5.4e`), and a line that pretended otherwise would lie about the one case the journal
  exists for. A step whose opening `QUEUED` lies beyond the loaded page stands on a line of its
  own until the rest of its run is fetched. An entry a person wrote carries its author beside the
  sentence; a line inside a run needs none — the run's own head already said who asked, and a run
  the pipeline started on its own says so by naming nobody.
  **A step also says who did the work:** the service it went to, and the id it was asked under, in
  monospace under its line with a copy control (§11.14) — values to be copied into a `grep`, not
  read (03 §3.3.18). The same id is on both halves of the pair, and on the request the service
  itself logged, so "analysis failed" stops being a dead end. An admin additionally sees the host,
  which nobody else can act on and nobody else is shown.
  The journal arrives a page at a time, and its foot offers **Show more** while the server holds
  more (`07 §7.3`): a history that silently ends at the page boundary reads as "nothing older
  happened", which is false as soon as a document has been re-run a few times — one full run
  already writes more than a third of a page. It is fetched only when the tab is open — most
  visits never ask. The panel above it costs nothing extra: its states are read off the document
  the screen already holds and already polls, and its durations off the page the journal fetched
  anyway.
- **Right (sidebar), opening with what the document is called:** the **title** — inline-editable when
  permitted, and wrapping rather than truncating, because a document's name is the one string on this
  screen nobody may be shown half of — and directly under it the **description**, in secondary text,
  a line or two of what this is and between whom (`03 §3.3.10`), inline-editable on the same terms
  and drawn as an em dash where the analysis has not written one yet. There is exactly one of each on
  the screen: these are the title and the description that used to sit over the tabs, and a name in
  two places is a name somebody will edit in the wrong one. Both edit **in place** — a click on the
  text, not a form — which is what they have always done and what keeps them out of the Details
  editor, where a field is corrected rather than written. 🔒 The `E` shortcut below belongs to the
  Details pane and does nothing while an inline editor holds the focus: a bare letter that opens a
  form while somebody is typing a title is a bare letter that eats the title. Then the
  **Add-to-collection** select — only the caller's own collections, because adding to somebody
  else's is not a thing a reader may do (`03 §3.4`) — and then **the page itself**, the first-page
  preview, shown only once that step has produced one. Small on purpose: the readable copy is the
  pane on the left, and this answers "is this the right document", which is a glance rather than a
  read. And that is the whole panel.
  🔒 **What the sidebar is for, and what it is not.** It says what the document is called, what it is
  about in a line, and what it looks like — it is the label on the folder, not a control room. Every
  action that used to stand here has gone to the tab that owns the question it answers: **Download**
  and **Delete** to `Files`, because both are about the bytes the document is made of (§11.5a);
  the **links** to `Related` (§11.5e); the **processing panel** to `Log`, beside the history of the
  same work. A panel carrying a download, a delete, a link picker, six step rows and a reprocess
  button was a second screen standing next to the first, and it was drawn in full on every document
  whether or not anybody had come to act on one — while the tabs, which is where somebody who *has*
  come to act already looks, were half empty. Reading is the common case here as it is in the Details
  pane, and the rule is the same: the panel beside the document holds what is read at a glance, and
  everything that is *done* lives where its subject lives.
  **The document type is deliberately not among these** either. It is one of the things a machine
  decided, and those are corrected in the Details pane and nowhere else (above): a select here would
  be a second place to change one field, which is how the two halves of one screen come to disagree
  about what it holds.

## 11.5d. Deleting a document

**Admin only, at the foot of the `Files` tab, below everything the document can still be used for**
(`07 §7.3`). It belongs to that tab because a deletion is a decision about the bytes: what the modal
below has to say is an inventory of files, counted and weighed, and the list it is counting is the
one on the screen. It is the **last** thing in the tab, under the file rows and a rule of its own,
while **Download** is at the top — 🔒 a destructive action that shares an edge with Download is a
destructive action somebody will press by accident, and putting both in one tab is only safe as
long as the whole list stands between them. It is drawn in the red the rest of the screen never
uses.

**The confirmation is a modal and not a popover, because it has something to say.** A deletion here
is real (`03 §3.3.10`, ADR-015 as amended) and nothing undoes it, so the modal is written as an
inventory rather than as a warning — it names what is about to go and, just as plainly, what will
not:

- **Gone:** this document, its text and search index, its history and its place in any collection.
  Those are records about files, and none of them survives.
- **To the trash:** the files it is made of — counted, and with what they weigh, because "3 files,
  12.4 MB" is the fact that makes the decision and it is already on the page. The line says where
  they go and that they can be got back from there (`05 §5.7a`), which is what makes this modal a
  decision about a document rather than about the only copy of a scan.
- **Kept on the volume:** the originals lying in a library. They are on a read-only mount and Legere
  does not delete them; the line says so, and says the file will not be read again either — the one
  thing a person cannot infer, and the difference between "deleted" and "deleted until the next
  scan". Shown only when there is such a file to talk about: a document made of uploads has nothing
  of the sort, and a modal that says so anyway is a modal being read past.

The confirm button is red and says **Delete**, not "OK". While the request is in flight it is busy
and the modal stays; on failure the modal stays too, with the error where it happened. On success the
reader is sent to `/documents` — the document they were looking at does not exist, so the address it
lived at must not be where they are left — and the archive is re-fetched under them.

## 11.5a. The Files tab

A document is an ordered list of **pages** (`03 §3.3.17`, ADR-025), and this is where that list is
visible and worked on. **A tab of its own, not a section at the foot of `Details`.** What a document
is made of is a different question from what it is about, and it is the one thing on this screen that
is worked on rather than read: pages put back in order, a photograph cropped, a page that belongs
elsewhere moved there. Underneath the metadata it began below a form nobody had opened and a table of
step costs nobody had asked for, so "which of these forty scans is upside down" was a scroll past
everything the document knows about itself. Its own tab is one press from anywhere, and a link to
`/documents/:id/files` is a link to the composition — which is the address to send somebody when the
pages are in the wrong order.

**The tab keeps its name and leads with the pages.** A document is still made of files, they are
still listed here and they are still where the bytes are downloaded and replaced — so the tab is
still `Files` and the address that already points at the composition still points at it. What
changed is which of the two comes first: the pages are what somebody came to arrange, and the files
are where they came from.

**The tab opens with the two things you can do with the document as a whole**: the **Download split
button** of §11.5b on the left, **Add files** on the right, and the rebuild note under them. This is
where they belong rather than in the sidebar: "the document as one piece", "one of the originals"
and "these are the originals" are three answers to one question, and the dropdown of the first is a
list of exactly the file rows below. A person who came for the bytes now comes to one place.
**Delete** closes the tab from the other end — §11.5d.

### The page strip

**Every page of every file, in the order the canonical will hold them.** One tile per entry of
`pages` (`03 §3.3.17`): a thumbnail, the number it stands at in the **document** — 7 of 24, not
"page 3 of the second file" — and, under it, where it came from: the file's name and which page of
it. The two together are what makes a strip across two scans readable at all, because "page 3" means
nothing in a document that holds three files with a page 3 each.

Each thumbnail is the page of the **original** as it arrived: a page of a PDF from
`GET …/files/:fileId/pages/:page/thumb` (`07 §7.3`), a photograph from its own bytes. They are
fetched lazily, so a hundred-page document asks for what is on the screen and not for what is below
it.

🔒 **A file nobody has counted the pages of is drawn as one tile that says so.** Until the first
canonical build a file is held as a single entry with no page index (`03 §3.3.17`), and it occupies
**one** position: an insert lands before it or after it, never inside it. The tile says "the whole
file" rather than "page 1", has no thumbnail to show — nothing yet knows how many pages there are to
render one of — and offers neither a turn nor a crop, because both are written on a page and this
entry is not one yet. The strip states that honestly instead of drawing a page it cannot name; the
next build expands the entry and the tiles appear. 🔒 A **photograph** is never one of these: an
image is one page and always was, whatever has or has not counted it, so it is drawn and named as
itself.

**A page is dragged into place anywhere in the document, and moved with the keyboard.** Dragging is a
pointer gesture and a finger is a pointer: the page follows it and the strip closes around where it
will land, so the gesture works on the tablet the scans were made on rather than only at a desk. The
drag is over the **whole strip** and not inside one file — a page picked up anywhere lands anywhere,
which is what makes putting twenty scans in order one gesture rather than twenty. 🔒 **The arrow keys
do the same work** — a focused page moves one position at a time and keeps the focus as it travels —
for the reason the grid's cards give in §11.3: a hit area only a mouse can use is half a fix.

**Nothing is sent until it is saved.** The strip holds the pending order and the pending turns
itself, with **Save** and **Cancel** under it: Save sends the **whole order** — every page of the
document exactly once (`07 §7.3`) — and the turns beside it, and Cancel puts the strip back to what
the document says, having sent nothing at all. Both are quiet while the two agree, because a Save
that would change nothing is a request that says nothing.

🔒 **And what is held is held against the *set* of pages, not against their order.** The document
polls every five seconds while it is processing — which it is after every composition edit — so a
strip that started afresh whenever the answer differed would be a strip that lost an arrangement to
somebody else's reorder, with nothing said. A page arriving or leaving is the one change a pending
arrangement cannot survive: it is a list of exactly these pages, and it is no longer exactly these
pages. That, and only that, puts the strip back to what the document says — **and it says so**, in
the same words wherever it happens, rather than letting the work vanish behind whatever else was on
screen at the time. The commonest way it happens is a save refused for a reason that also changed
the composition, where an error message alone would explain the refusal and say nothing about the
half-hour of arranging that went with it.

**A page is turned where it stands.** Under each tile sit **turn left** and **turn right**, one page
at a time — because a forty-page scan has three pages lying sideways and not forty — and the
thumbnail turns with them, so what the strip shows is what the page will be. The picture itself is
still the page as it arrived, asked for by the same route and cached under the same key (`07 §7.3`):
the bytes cannot change, so the strip turns what it draws rather than sending anything to be
re-rendered.

**And the rest of what can be done to one page, in place, from the tile:**

- **Crop** — the editor of §11.5c, for **any** page there is a picture of. Which way up and how much
  of it is paper are one question about one page, and that editor is where both are answered — for a
  page of a PDF exactly as for a photograph, because the crop is written on the entry and the build
  honours it either way (`03 §3.3.17`).
- **Remove** — the page leaves the document and the rest close up behind it (`07 §7.3`). Not offered
  on the only page there is: a document is emptied by deleting it, not by taking its pages away one
  at a time.
- **Split here** — the document is cut **before** this page into two, over the same files and with no
  bytes copied (`05 §5.6`); the parts are linked to each other. Not offered on the first page, which
  is a cut with nothing on one side of it.
- **Move to…** — the selected pages leave for another document, an existing one or a new one made to
  hold them. The dialog searches documents the way everything is searched (§11.5e) and says which it
  will move: the pages by their numbers in **this** document, in document order whatever order they
  were ticked in, because a tile's own **Move** and twelve ticked pages open the same dialog and a
  confirmation that does not say what it is about is one nobody can check before pressing.
  🔒 Its search settles before it is sent, the way the overlay's does (§11.1a). That is not only
  politeness here: every non-text search spends an outbound embeddings call and is metered per
  caller ([`08 §8.4`](./08-auth-and-authorization.md)), so a title typed a character at a time ends
  in `RATE_LIMITED` and an empty list — the one moment the picker had to work.

**Pages are selected for the two that act on more than one.** A checkbox on each tile, a count above
the strip, and **Move to…** beside it; **Clear** empties the selection. Selecting nothing and using a
tile's own **Move to…** moves that one page, which is the same request with one id in it.

🔒 **While there is an order nobody has saved, the controls that send something are quiet.** A
position is a place in the list the server was last shown (`03 §3.3.17`), so removing a page or
cutting "here" while the strip holds an order that has not been sent would be a request about a
document that does not exist yet. Save or Cancel first — which is the same promise as "nothing is
sent until it is saved", said from the other side.

**A file goes in between two pages.** Between every pair of tiles — and at both ends — sits an
**insert point**: a file dragged from the desktop and dropped there goes **there**, and the same
control opens the file picker when it is pressed, so the gesture has a keyboard path like everything
else here. What is chosen goes into the same global queue and is watched in the same panel (§11.3a),
addressed to this document **at that position** (`POST /api/documents/:id/files?at=`) rather than
appended; several files dropped at one place go in one after another, in the order they were chosen.
The **last** insert point is the exception, and it is an append rather than a position — §11.3a says
why. **Add files** at the head of the tab is the same thing with no position: it appends, which is
what it always did.

Two details of the insert point are behaviour rather than decoration, and both are §11.3's rules
applied to a seam instead of to the page. **Enters and leaves are counted in pairs**: the seam holds
the picker's own button, `dragleave` fires the moment a pointer crosses into a child, and a
highlight that believed the first leave would go out and come back in the next frame under a pointer
that never left. And **a drop the strip is going to refuse says so**: while an order is unsaved every
insert point is closed (above), the browser will hand over the file anyway, and a file that
disappears without a word is worse than one that was never taken — the cursor says no during the
drag, and the drop answers with the same sentence the closed controls carry.

### The file rows

Under the strip, under a heading of its own — **Originals**, which is what §11.5b already calls
them, and never "Files", because a heading under the tab's own label is the same word twice — one row
per file, in the order the document first reads them, and now only what is genuinely about a
**file**: its thumbnail, name, kind and size, a `MISSING` tag when the volume no longer has it, where
its bytes are, **Download** and **Replace**. Everything that was about how a
page reads — the crop, the turn, the order, splitting off, moving up and down — is on the strip
above, where the page it acts on is drawn. Two lists that disagreed about the same document is
exactly what ADR-025 was written to end.

**Every file says where it is, not only the ones on a volume.** A managed file — an upload, or
something Legere made — has no library path, and used to say nothing at all here, which left a
document made of uploads looking like one with no whereabouts. It names **the object storage**, as
such, and the key its bytes are under (`09 §9.2`), in that same line under the file. 🔒 As text, in
the same monospace the library path uses, and **never as a link**: the key is a location and grants
nothing on its own — the bucket is private and only a signed URL reads it — so anything that looked
clickable would be a promise it will not keep. **Download** on the row is the way to the bytes, and
it is right there.

**The list holds real files only.** A row appears when its file has landed and the list is refetched,
never before: a file on its way is watched in the upload panel, where every other upload is watched,
so nothing in the composition of a document is a row that might yet turn out not to exist. Leaving the
tab does not abandon what is going up, either — the queue is the application's, not the screen's.

**Replace** opens the file picker and sends what is chosen in place of that row — the new scan takes
the same positions, so the page order does not move, and every page that reads those bytes reads the
new ones. It is one gesture because it is one intention: a page re-photographed is still that page,
and doing it as split-upload-reorder is three operations to say so. This one shows itself **on the row
it replaces**, not in the upload panel: a replacement is not a file joining the document but the same
page arriving again, and it already has a line of its own to be busy on.

**Under a replaced row: the copies it has had.** "Earlier versions (2)", collapsed, each with its
name, size, when it was replaced and a **Download** — the old scan is still readable, which is the
whole reason it was kept. They live in the trash (`05 §5.7a`) and the line says where they are going:
a file of ours names the day it will be deleted, and a library original says it is on the volume and
that Legere will not read it again. Getting one back into a document is done from the trash and makes
a new document, so nothing here pretends to be an undo of the page order.

Every one of these rebuilds the document — the canonical PDF, the preview, the text, the analysis —
so the tab says so once, quietly, at its head: "Changing the files rebuilds the document." While that
happens the strip and the rows stay usable and the document keeps showing what it had. The tab is
named `Files` and nothing inside it repeats that name: a heading under its own label is the same word
twice.

## 11.5b. Download: the document, or what it was made of

**Download** is a split button, at the head of the `Files` tab (§11.5a). Its main half hands over the
**canonical PDF** — the document as one
piece, searchable, straightened, in page order — because that is what somebody asking for "the
document" means. Its dropdown lists the originals, one entry per file, named as they arrived, each
downloading exactly those bytes; a file the volume has lost is listed disabled with the reason.

The default is never silently the original: a document made of forty photographs downloads as one
PDF, and a person who wants photograph 23 asks for photograph 23. Until the canonical has been
built the main half is disabled with "Being assembled…", and the originals remain available
throughout — the dropdown is the answer to "I need the raw file", and it should work on the worst
day, when the pipeline is broken.

## 11.5c. The crop editor

Opened from a **page** of the strip of §11.5a, and it edits that page: what it stores it stores on
the entry (`PATCH /api/documents/:id/pages/:pageId`, `07 §7.3`), which is what lets two documents
crop one photograph apart and what lets a page of a PDF be cropped at all. A modal over the image at
the largest size that fits,
with **four draggable corner handles** joined by a polygon and the outside dimmed — a quadrilateral,
not a rectangle, because a page photographed at an angle is not a rectangle and forcing one either
cuts the corner off or keeps the table it is lying on.

- **Auto-detect corners** asks the server (`GET …/crop-suggestion`) and drops the answer into the
  editor for the person to accept or drag. It is a proposal and says so; it never saves by itself.
  🔒 Offered only for an **image**: the detector reads a photograph of a page and the endpoint
  refuses anything else (`05 §5.6`), so a button on a PDF page would be one that only ever fails.
- **Rotate left**, **Rotate right** and **Mirror** say which way up the paper lay — the correction a
  reader makes in a second, and one this editor is the place for, because "which part of this" and
  "which way up" are one question about one page. They are buttons like every other control here and
  are reached with the keyboard like every other control here. 🔒 **The mirror is a photograph's
  question.** A PDF page arrives the way its producer laid it out, so it turns in quarters and is
  never reflected; the button is not drawn there.
- **What is under the corners** is the page as it can be shown: a photograph is its own bytes at
  their own resolution, and a page of a PDF is the small JPG the page-thumb route renders (`07 §7.3`),
  which is the only picture of one page there is. A crop is stored normalized to 0…1, so a scaled
  picture places a corner exactly where a full-size one would — what a smaller picture costs is what
  the loupe can magnify, and the modal says so rather than pretending otherwise.
- **Clear crop** clears the crop entirely — the page goes into the canonical whole.
- **Reset turn** clears the turn the same way: it sends `null` and the page reads the way up it
  arrived, there having never been anything to undo (`03 §3.3.17`).
- **Save** stores the quadrilateral and the turn together — one edit, one rebuild — and the modal
  closes on the answer, not on the click, so a failure is visible where it happened.
- Handles are draggable with a pointer and nudgeable with the arrow keys once focused (1 px, 10 px
  with Shift), because the last two pixels of a corner are not a mouse gesture.
- The preview inside the modal shows the source image as it is; the perspective correction happens
  when the canonical is built, and the modal says what the result will be ("the page will be
  straightened to a rectangle") rather than pretending to render it.
- **What it draws turns with the buttons.** The picture, the crop outline, the handles and the loupe
  all stand in the page's current orientation, because a corner marked on a page that has since moved
  is a corner in the wrong place. The quadrilateral is still *stored* against the pixels that
  arrived — that is what lets the build apply the crop first and the turn after it (`05 §5.6`) — so
  the editor turns the points on the way in and turns them back on the way out, and a person only
  ever drags corners onto the page they are looking at.
  🔒 **A turn renames the corners as well as moving them.** A crop is a *list* of four corners
  clockwise from the top-left (`03 §3.3.16`), and after a quarter turn clockwise the corner that was
  top-left is the top-right one. Move the points without re-lettering the list and the stored quad
  carries a second copy of the turn into a build that is about to turn the page again — a quarter
  turn asked for and a half turn delivered.

**While a corner is being placed, a loupe watches it.** The image is on screen at whatever fits
under 60 vh, so a photograph three thousand pixels wide arrives at about a fifth of its resolution —
and the corner being placed is under the very pointer placing it. A small square floats beside the
handle showing that corner's neighbourhood **from the source image at no less than its own
resolution**: the modal scales the image down, the loupe does not, so the last two pixels are
visible at the moment they are being chosen rather than after the document has been rebuilt. The
crop outline runs through it and a crosshair marks the exact point — a magnified patch of paper with
no line across it says nothing about where the corner is. It follows the corner while it moves, sits
beside the handle rather than under it — flipping to the other side, or below, when that edge of the
image is close — and never leaves the image it is magnifying, which is what keeps it inside the
modal. Until the image has loaded there is nothing to magnify and no loupe appears.

**The keyboard gets the same eye.** The loupe shows while a focused handle is being nudged and stays
until the handle is left, because the arrow keys are exactly the moment one pixel matters; a pointer
that lets the corner go takes the loupe with it. It costs nothing to fetch — it draws from the very
image the modal has already loaded, never a second request for the same bytes — and it says nothing:
a caption on a magnifying glass would be words at the one moment a person is looking at pixels.

## 11.5e. The Related tab

The edges of `03 §3.3.23`: the papers that belong with this one — the act with its contract, the
receipt with the act — and the ones the archive noticed citing it (`05 §5.6b`). **A tab of its own,
not a card in the sidebar.** A link is a document, and a document deserves the width a document is
shown at: as a card in a 8/24 column each one was a truncated line of text with an unlink beside it,
and the picker that finds the next one had one search box's worth of room to show its results in.
The tab also gives the connection an address — `/documents/:id/related` is a link to what this paper
answers, which is the thing to send somebody who asks how the two are related.

- **Link a document…** at the top, a search picker over the archive (the same `GET /api/search` the
  overlay uses, ranked by the server and never re-sorted here), because the papers related only in
  somebody's head are found the way anything is found. It stands above the list rather than under it
  for the same reason **Add files** does in §11.5a: the thing you came to do is not at the bottom of
  what is already done.
- **The links**, one row each, laid out like the file rows of §11.5a: the other document's
  first-page thumbnail, its title as a link into its own viewer, its type, and an **unlink** for
  whoever may edit. The thumbnail is what the sidebar never had room for, and it is the fastest
  answer to "which act was that".
- **The suggestions** of `05 §5.6b` under their own quieter heading, each saying which identifiers
  matched — "cites № 12-2019" — with **Link**, **Combine**, **It's a duplicate** for an admin, and
  **Dismiss**. Dismissing is client-side and lasts the session, exactly like the grouping
  suggestions of §11.3: the server proposes and never remembers being refused.

**Asked for only when the tab is opened**, exactly like the log: the suggestions cost the server one
phrase search per identifier the document carries (`05 §5.6b`), and they used to be computed on
every visit to every document to fill a card most readers never looked at.

**A row is not a document, so pressing one opens the document.** A title, a type and a thumbnail are
enough to tell two acts apart and nowhere near enough to decide anything about them: whoever is
asked "is this the contract that receipt settles" needs the paper, and until now the answer cost
leaving the tab for the other document's viewer and finding the way back — which is why a list of
five proposals was a list nobody acted on. **Pressing a suggestion opens it in place:** a modal
holding the candidate as §11.5 draws it — the canonical PDF, the text, the log, the details, the
files, under the same tabs — with its title at the head as a link into the full viewer, for whoever
does want the place where a document is worked on.

🔒 **The peek reads and never writes.** Nothing in it edits, uploads, re-runs, crops, reorders,
splits or deletes: it is a look at somebody else's document taken in the middle of a decision about
this one, and an editor opened there is an editor nobody navigated to — the reader would be
correcting the wrong paper's metadata with this paper's question still on screen. Every pane is
drawn exactly as the viewer draws it for a reader who may not edit, which is a state each of them
already has (§11.5, §11.5a, §11.5d): what survives is what reading needs, the downloads included.

🔒 **And it holds no list of documents.** The peeked document's own Related tab is not among the
tabs: suggestions inside a suggestion are a corridor, and the question in front of the reader is
about the two documents they already have. The way to that document's own edges is the title link,
which is the way to the whole of it.

**The foot of the peek carries the decision**, where the reader has just finished reading — and it
is the row's own verbs, so nothing is offered in one place and hidden in the other:

- **Link** — the ordinary edge of `03 §3.3.23`, the same `POST /api/documents/:id/links` the row's
  Link makes. The peek closes and the candidate moves from the proposals up into the links.
- **Combine** — the two are not two papers: the other's files are appended to this one and its
  record goes (`POST /api/documents/:id/combine`, `05 §5.6`), and this document rebuilds. 🔒 Behind
  a confirmation, unlike the deliberate tick-two-and-press of §11.3: a press in a list of proposals
  is a small gesture, and what it agrees to is that a document stops existing.
- **It's a duplicate** — ADMIN only: the same paper scanned twice, of which this one is the copy
  worth keeping, so the other is **deleted** (`DELETE /api/documents/:id`, `03 §3.3.10`) rather than
  merged into a document that would then hold every page twice. 🔒 Behind the same inventory the
  Files tab's own delete reads out (§11.5d) — how many files and how much of them go, that the
  originals on the volume stay where they are and no scan will ingest them again, and that this is
  not reversible. A reader who is not an admin is not offered it: the endpoint refuses them
  (`07 §7.3`), and a button that buys a `403` is a button that lies.
- **Cancel** — closes the peek and changes nothing. Dismissing the proposal is the row's own
  business, and stays there: closing a look is not refusing a suggestion.

🔒 **The tab is always there, and says so when there is nothing in it.** The card it replaces drew
nothing at all when there were no links and no suggestions, which was right for a card standing in
a panel nobody asked to see — an empty box on every document teaches the eye to skip the box. A tab
is not that: it is a place somebody navigated to, and one that vanished when a document had no links
would take the picker with it, so the way to make the first link would exist only on documents that
already have one. The empty state says there are none, and the picker above it stays.

## 11.6. Search (`/search?q=`)

Search input + mode toggle (`Hybrid | Text | Semantic`; semantic disabled with a tooltip when
`semanticAvailable=false`), filter bar (library, document type). Results: list rows — thumbnail, title,
highlighted snippet (`<mark>`), document type, score-ordered. Empty query → recent documents. No results →
suggestions ("check spelling, try semantic mode").

**The search says what it searches.** A box with a magnifying glass in it is a promise nobody can
read the terms of: typing the name of a scan and getting nothing back teaches a person that the
archive does not hold it, when what actually happened is that they searched for something the
instrument was not looking at. So the screen names its own reach in one line under the input — the
title, the fields read off the paper, the description, the text, the place, and **the names of the
files, the people and the things** (`07 §7.3`) — and each mode says in a tooltip what it does with
the words: **Text** matches them, **Semantic** matches the meaning of the sentence against the text
of the documents, **Hybrid** runs both and fuses the two orderings.

**And every result says why it is here.** A row carries small quiet tags for the parts that matched
— *title*, *file name*, *person*, *thing*, *field*, *description*, *place*, *text*, *meaning* —
because a hit whose snippet quotes a paragraph that does not contain the query reads as a bug, and
the honest answer is usually "because the scan is called that". It is the same answer the
suggestions of §11.5e give beside a proposal, for the same reason: a machine that proposes something
owes the reader what it went on. The tags stand on the search screen and not in the overlay
(§11.1a): the overlay is three rows and a way in, and a column of tags in it would be an
explanation nobody stopped to read.

**The overlay is the quick way in; this is the instrument.** Most searches are answered by the first
few rows of §11.1a and never arrive here — but the modes, the filters and the whole ranked list are
here, with an input of its own inside its own content, because narrowing a search is work done with
the results in front of you and an overlay is not a place to work. Two doors, both real: the
overlay's **All results** row, and `?q=` in the address. A page opened with a query already in the
URL runs it on arrival rather than waiting to be asked a second time — that address is what somebody
pasted into a chat, and it has to be the search and not a form remembering the words.

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
reset link (modal shows the URL once with a copy button and expiry). **Invite user** stands above the
table, over the list of invites it fills rather than in a bar a screen's width away from both
(§11.1): modal (role select, optional email hint) → result modal with the invite URL (copy button,
"shown only once" warning) + the active invites list below the table with revoke actions.

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
one flat arrives four times, one person three — and one *kind* as `жильё`, `Жильё` and `car` beside
`автомобиль` (03 §3.3.20a). Rows carry checkboxes on all three screens; with two or more selected,
**Merge** asks the only question that matters — *which of these is the right name* — offering the
selected names and taking anything typed over them. For subjects it asks for the kind too, since the
selected rows may disagree. Everything then folds into one row and no document loses what it named.
A kinds merge folds shelves: the surviving kind receives every thing the others held, and a thing
both sides held under one name is folded along the way rather than left to violate the catalogue's
own identity (03 §3.3.20a).

**The screens notice the duplicates first.** An admin arriving at a catalogue of a hundred and
thirty names should not have to read it like a proofreader. On each of the three screens, when the
analyst has proposals (`05 §5.6c`), a banner above the table says so — *these look like the same
person*, the same thing, the same kind — one row per group, each showing what it would fold together
(for subjects, with the kind beside each name) and a **Merge** button that opens the ordinary merge
dialog with exactly those rows selected and the analyst's answer prefilled: its spelling as the
name, its kind for a subject, its tidy "also known as" line in the note. The dialog is the same
dialog — everything editable, nothing merged until confirmed — because the suggestion is a question,
not an act. On `/subjects` the banner has a second part when the analyst found any: **rows that name
a kind rather than a thing** — "жильё" filed under жильё — each with a Delete behind the ordinary
confirmation, because analysis noise is deleted one confirmed row at a time, not swept. The banner
closes like any banner and is proposed afresh next visit (the server never remembers being refused,
`05 §5.6a`); while suggestions are being computed the table simply has no banner yet, and without a
configured analyst there is none at all — the screens work as they always did.

**And when the analyst could not be asked, the screen says so instead of showing nothing.** An empty
banner area used to mean two different things — a catalogue with no duplicates, and a provider that
answered `500` — and an admin had no way to tell them apart, which is how the feature stayed dead
for months (`05 §5.6c`). So the `UNAVAILABLE` reading draws a notice of its own in the banner's
place and in the banner's language: the same one-line, closable strip above the table, in the
warning tone rather than the informational one, saying that the analyst could not be asked, that
nothing is wrong with the catalogue, and that the next visit asks again. It carries no group, no
button and no provider error text — an admin cannot act on a stack trace, and the operator who can
has the log line (`06 §6.7`). It closes like the suggestions banner and is proposed afresh next
visit, for the same reason. The two other readings are unchanged: `UNCONFIGURED` draws nothing at
all, and an analyst that was asked and proposed nothing draws nothing either — that silence is now
the only silence that means "there is nothing here".

**Nothing written on the merged rows is thrown away.** The dialog's note field arrives prefilled with
what the rows carried: the names that are about to disappear ("Also known as: …") and every note any
of them had, one per line. It is an ordinary editable field — a person deletes what is noise and
keeps what is not — but the default is "keep everything", because the alternative is a merge that
quietly destroys the one line somebody wrote a year ago to explain which flat this is.

**The "also known as" line is tidied when the analyst can read it.** A raw dump of every selected
spelling repeats the survivor in three cases and keeps the airline's `/MR`; the analyst's line keeps
each *distinct* spelling once (`05 §5.6c`). On every catalogue screen a hand-selected merge asks for
that reading when the dialog opens — the raw prefill appears at once and is replaced by the tidy one
when it arrives (for a subject, the kind select with it), unless the person has already started
editing, because a form must never fight its user. A suggested merge opens tidy from the start, the
answer having come with the suggestion. Either way the prefill respects the note's own limit: what
does not fit is cut from the end, and the field validates the limit like any other — a prefill the
server would refuse is a bug, not a default (M48.1).

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

**Four tabs, because four different questions are asked of this screen** — and one page holding all
four answered none of them at a glance. It held five stage cards, a table of steps inside one of them,
a block of external services, a table of failures and a storage figure, in one column a metre long:
everything was there, and finding any of it meant scrolling past the rest.

| Tab | The question it answers | What is on it |
|---|---|---|
| **Overview** | is anything moving? | one row per stage, and what the bucket holds |
| **Pipeline** | where are the documents stuck? | the six steps of `05 §5.5`, their counters and their switches |
| **Services** | is the thing we call answering, and how hard are we asking? | one row per external service |
| **Failures** | what broke, and can it be run again? | the failed-jobs table |

The open tab is **part of the address** (`/admin/queue/:tab`, `overview` at the bare path), the way the
viewer's tabs are (`§11.5`): a link to this screen can be a link to the failures. And, for the same
reason as there, **the tab switches on the click** rather than after the navigation.

**Every control lives beside the numbers it governs**, which is the rule the one-page version was
built on and the tabs keep — one level down each: a stage's concurrency and its pause on the stage's
own row in **Overview**, a step's pause on the step's own row in **Pipeline**, a service's gate on the
service's row in **Services**. Nothing has to be looked for in another tab to be understood.

🔒 **The auto-refresh switch is not called a pause.** It sits in the header, applies to whichever tab
is open, and reads *Refresh automatically* — because this screen already has two pauses that stop real
work (a queue's and a step's), and a third one that merely stops the numbers from moving was the
difference between reading this page and misreading it.

### Overview

- **A summary line** across the top: what is *not* in order, in one sentence — queues paused, steps
  held, failures in the last day, a service that did not answer — each naming the tab that deals with
  it. When everything is in order it says so in as many words, because the absence of a warning is
  otherwise indistinguishable from a page that has not finished loading.
- **One row per stage** rather than a card per stage: the stage **named twice** (what it does, over
  what the queue calls it — the technical name is what the failures table and the container's logs
  say), one line saying what it actually does, its depth as **queued / active / failed in 24 h**, the
  **concurrency** that decides how fast the depth falls, and the switch that says whether the stage
  runs at all. A paused stage is tagged as paused on its own row, so a growing queue is never mistaken
  for a stuck one. A zero failure count is not drawn as a zero.
- **What the bucket holds**, as of the last `maintenance` run, and `null` until the first one.

### Pipeline

Everything about the inside of `document-process`, which is the only stage that has an inside.

- **The six steps as a table**: one row per step, one column per status, so the same word lands in the
  same place on every line and "which steps are still queued" is answered by reading down a column
  instead of hunting across five rows of chips. Empty cells are the price and they are worth it — a
  gap under a column says "none of these" at a glance, which a missing chip cannot. A zero is not
  drawn: an archive where nothing failed should not read as a wall of noughts. The steps are named
  **exactly as the document's own page names them** (`§11.5`): one screen calling a step "Тип" while
  the other calls it "Анализ" is two names for one thing, and the reader is left to work out that they
  are the same. Statuses are shown as the words the filters use, not as the enum. **Every number is a
  link**: it goes to `/documents?step=preview&stepStatus=FAILED` — the documents behind it. A counter
  nobody can act on is a number on a wall; the point of "12 failed previews" is the twelve documents.
- **Run again, at three widths**, and each is a different question rather than a bigger version of
  the last: beside a **status**, the documents whose step sits in it; beside a **step**, that step
  for every document whatever state it is in; and at the top of the tab, the **whole pipeline** of
  every document. 🔒 Every status carries it, not only the two that look broken — a step is re-run
  because something *about it* changed, a container gained a language, a model was configured, a bug
  was fixed, and by then the documents that need redoing are precisely the ones marked `DONE`.
  Asking for a `QUEUED` one is not a mistake either: the job is keyed by the document, so a second
  request collapses into the first rather than doubling it. Each says how many it enqueued and each
  is capped per call, so a huge archive drains in batches rather than in one indigestible push.
  It is an **icon**, repeated once per status per step: a worded button was the widest thing in the
  row and pushed the counts off the card, and what it does is said on hover and to a screen reader,
  where a repeated label belongs (`§11.15`). A **paused** step offers none of them: a re-run of it is
  refused (`07 §7.3`), and an icon that answers `409` is worse than an icon that is not there.
- **Pause and resume one step**, on the step's own row, because the step is the thing being stopped
  and the row is where it is already named. The same switch as a stage's, read the same way — **on
  means the step runs** — so the two paused things on this screen read alike, and the row of a paused
  step is tagged as paused beside its counts. It is the knob for the trouble an operator actually has:
  an analyst answering nonsense, a Docling container thrashing. Pausing the stage instead would stop
  the previews and the vectors to stop the analysis, and every document would wait on a step that was
  never the problem. A paused step is **held, not skipped** (`05 §5.4d`): the documents queue up at
  it, nothing is written against it, and resuming sets them going again — which the switch says in a
  line under it, since "paused" alone leaves a reader to guess whether the work was dropped. It takes
  effect on the next document with no restart and no re-registered worker.
- 🔒 **A step that is waiting for its service says so**, on its own row: *waiting for Stirling: 2*,
  read from the gate's own counters (`05 §5.4b`). Without it the table is honestly unreadable at the
  one moment it matters — two documents both show `RUNNING` at the same step while one of them is
  standing at a gate, because waiting at a gate is time inside the job and the step is marked
  `RUNNING` before the wait begins. That reads exactly like a gate that does nothing, and it cost an
  operator an afternoon of looking for a bug that was not there.
- **How many units inside one job** run at once, and **the language the analysis writes in**: both
  belong to this tab because both are about what happens inside one document's run.

### Services

One row per external service of `05 §5.4b` — Stirling, Docling, the analyst, the transcriber, the
embeddings — **named twice** the way the stages are, what it is over what it is called in the
settings, with a line under it saying which work it serves, for a reader who has never opened
`05 §5.4b`.

- **Where it is, and whether it answers** (`05 §5.4c`). The **address** sits under the line saying
  what the service does, as code and truncated rather than wrapped — it is read to be recognised, not
  transcribed — and where none is configured it says so in words instead of drawing an empty box. The
  **state** is a tag, one of the five of `05 §5.4c`, coloured for what it costs: `UP` green,
  `UNAUTHORIZED` and `ANSWERED` amber because something is there and something is wrong with it,
  `DOWN` red, `NOT_CONFIGURED` grey — a service this instance was never given is not a fault, and must
  not read as one. What the tag cannot hold — the HTTP code, how long the probe took, when it was
  taken, the reason — is on hover, where a detail belongs (`§11.14`). One **Check** button for all
  five, saying when it last looked; it checks on opening and then only when asked or when the page's
  own auto-refresh is running, at a **slower cadence than the counters**, since a probe leaves the
  instance and a counter does not. 🔒 It never blocks the rest of the row: gates and their inputs draw
  and save while every probe is still out, because a page that waits for a dead container to time out
  is the page an operator cannot use at exactly the moment they need it.
- **How hard it may be asked**: two inputs — **how many calls it may be doing at once**, where `0`
  reads as "as many as the queues ask for", and **how long to wait after one before starting the
  next**. Both are `0` until somebody changes them, so a block of zeroes is an instance whose services
  are not gated at all — which is what an upgrade leaves and what the page should say plainly rather
  than looking misconfigured. Saving is offered only once something differs from what the server
  holds, and takes effect without a restart.
- 🔒 **What the gate is doing right now**, beside the numbers that decide it: **in flight**, **waiting**
  and **how long the one at the front has been waiting** (`05 §5.4b`). This is the answer to "is the
  gate even working", and it is the number an operator reaches for when the queue looks stuck: a gate
  with one call in flight and three waiting is a throttle doing its job, and the same row with three
  in flight is a setting that never took. It is live, in-process and stored nowhere — a snapshot of
  this instant, refreshed with the counters rather than with the probes.

### Failures

The failed-jobs table: queue, payload summary, error, when, retry count, and a per-row **Retry**. The
tab's own label carries how many there are, so a failure is visible from the other three tabs without
opening this one.

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

## 11.13b. Admin: Trash (`/admin/trash`)

Every file that has left a document and not yet been destroyed (`05 §5.7a`), newest first. An
admin's screen, because everything on it either destroys bytes or makes a document.

At the top, what the trash costs: **how many files and what they weigh**, over the whole trash and
not the page — that number is the reason to open this screen at all — and one **Empty trash** behind
a confirmation naming the same figures.

One row per file: a thumbnail for an image, the name, its kind and size, **where it came from** (the
title the document had, and why it left — *replaced by a newer scan*, *its document was deleted*, or
*its last page was removed*, which is a document that is still there minus the page that read these
bytes), and **when it goes**:

- a file of ours says the date the sweep will delete it — "deleted on 12 March", not "in 27 days",
  because a date survives being read a week later;
- 🔒 a **library original** says instead that it is on a read-only volume and names its path. Legere
  cannot delete it and never will, and pretending otherwise with a countdown would be a promise it
  cannot keep. Deleting the row here removes only Legere's record — the line says that too, so
  nobody empties the trash expecting the disk to get smaller.

Per row: **Download** — the bytes are still there, and getting a file back out is often all somebody
wants — **Restore**, which makes a new document holding exactly that file and says so before it does
(it does not return to the document it came from, which has moved on or is gone), and **Delete**, for
good, behind a confirmation.

An empty trash says so plainly rather than showing an empty table: nothing here is a problem.

## 11.14. Cross-cutting UI rules

- Destructive actions always confirm (`Popconfirm`/modal) and name the object.
- All times shown in the browser's local timezone, absolute on hover (tooltip with ISO).
- Copyable technical values (hash, URLs) use a copy-icon affordance with a "Copied" toast.
- Toasts for imperative successes are quiet (2 s); errors persist until dismissed.
- Keyboard: dialogs close on Esc; wizard advances on Enter; grid supports arrow-key focus (antd
  defaults suffice — no custom hotkey system in MVP).
- No dark-pattern empty states: when something is admin-gated, tell the user who can fix it.
- Arriving at a screen draws a skeleton of that screen and not a spinner (§11.1); a skeleton is
  never drawn over a screen somebody is already on, and what the route-level one is allowed to cover
  is fixed in [`10 §10.2`](./10-frontend-architecture.md#102-routing-map).

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
| Surface | `#FFFDF8` | `#1C1917` | Cards and the sider; what floats sits a step above |
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

### The mark

One monogram, in two places: the collapsed sider, and the tab. A verdigris tile with a paper `L` —
the two colours the product is built from, and the pair that holds up against a light browser chrome
and a dark one alike, which a glyph on transparency does not. Drawn as a path rather than as text:
whatever renders a favicon has no reason to have IBM Plex Sans, and a monogram that falls back to
Times is not the monogram. `icon.svg` for everything that takes one, `apple-icon.png` for the
platform that wants a bitmap and no transparency.

### Surfaces, depth, motion

- Cards and panels: 1 px border in the **strong** border tone, radius 10, **no ambient shadow at
  rest**. Hover lifts 2 px, warms the border to primary, and adds one soft shadow — depth is an
  interaction, not a default. The border carries the whole separation, so it has to be seen: ~1.5:1
  against the page, not the ~1.2:1 a hairline gives. Hairlines are for divisions *inside* a surface —
  the rule under the wordmark, the line between a card's thumbnail and its body.
- **What floats sits on the raised surface** — antd's own `colorBgElevated`, a step above the card
  tone: modals, popovers, dropdowns and the search overlay (§11.1a). Something lifted over the page
  should read as lifted, which is the rule above said in colour rather than in shadow. It is antd's
  token and not one of ours, deliberately: an overlay takes the surface every modal in the product
  already has, rather than every modal being repainted to match one overlay.
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
