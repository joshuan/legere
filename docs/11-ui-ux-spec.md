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
| Scan sets | `/scan-sets` | all |
| Administration ▸ Libraries / Users / Categories / Queue | `/admin/*` | ADMIN |
| (footer) Settings, user avatar + name, Logout | `/settings` | all |

Top bar of content area: screen title, contextual actions, a global search input (submits to
`/search?q=`).

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
  `previewStatus != DONE`), title (2-line ellipsis), category tag, extension badge, and status badges:
  `processing` (spinner tag "Processing"), `UNAVAILABLE` (grey "File missing" tag).
- **Filter bar:** library select, category select, availability toggle, "processing only" toggle,
  source (All / From libraries / Created by me). Filters reflect in the URL query.
- Infinite scroll (`useInfiniteQuery`). Card click → viewer. Empty state (fresh instance): "No
  documents yet. Ask your administrator to add a library." — with a CTA to `/admin/libraries` for
  admins, and the upload affordance below, which any user can act on.
- **Upload** (header action, and a drop zone over the grid): picks one or more files and sends each to
  `POST /api/documents`, showing per-file progress. A finished upload appears in the grid immediately,
  still processing. Failures are reported per file and keep the rest going: too large
  (`UPLOAD_MAX_BYTES`), or `DOCUMENT_DUPLICATE` — "this file is already on this instance", which is
  what deduplication means from the outside.

## 11.4. Browse (`/browse/:libraryId?path=`)

Folder-tree navigation over the library's real directory structure (any nesting):
**Breadcrumb** (`Library name / sub / folder`), folder list (name + document count), then a document
grid of that folder (same cards as 11.3). Clicking a folder descends; breadcrumb ascends. Missing
files show as unavailable cards. This is the primary "explore what got mounted" scenario.

## 11.5. Document viewer (`/documents/:id`)

Two-pane layout:
- **Left (main): tabs** — `Preview` (canonical/source PDF in an `<object>`; for images the
  preview.jpg full-size; for text/markdown sources — rendered markdown), `Text` (rendered Markdown
  representation; empty state "No text extracted yet" / "Extraction failed" / "Being extracted…"
  while the step is `PENDING` or `RUNNING`), `Details` (metadata
  table: size, pages, mime, hash (copyable), created, OCR used, **languages** and **place**, file
  locations = visible FileRef paths with library names and MISSING badges, provenance for DERIVED
  docs — link to the scan set). Languages and the country are shown as names in the reader's own
  language (`Intl.DisplayNames`), not as the tags stored — "Serbian (Latin), Montenegro", not
  "sr-Latn, ME"; an em dash where nothing was detected, which is honest and never looks broken.
  **A field whose step has not settled carries that step's badge** — `RUNNING` or `PENDING`, the same
  words the processing panel uses — in place of the em dash, or in front of a value that is about to
  be rewritten. Which step owns which field follows the pipeline (05 §5.5): pages from the preview,
  text/languages/OCR from the parse, place and category from the AI step. Nothing else gets a badge:
  size, type and hash are facts about the file, and no step will ever change them.
- **Right (sidebar):** title (inline-editable when permitted), category select (all users with
  access; shows "auto" tag when `categorySource=AUTO`), Download source button (disabled +
  tooltip when `UNAVAILABLE`), Add-to-collection select, processing status panel: five steps, one row each
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

## 11.6. Search (`/search?q=`)

Search input + mode toggle (`Hybrid | Text | Semantic`; semantic disabled with a tooltip when
`semanticAvailable=false`), filter bar (library, category). Results: list rows — thumbnail, title,
highlighted snippet (`<mark>`), category, score-ordered. Empty query → recent documents. No results →
suggestions ("check spelling, try semantic mode").

## 11.7. Collections (`/collections`, `/collections/:id`)

- List: two groups — "My collections" and "Shared with me" (owner name shown). Create button → name
  dialog.
- Detail: header (name, description, inline-edit for owner), document grid (cards; owner sees a
  remove-from-collection action), **Share** button (owner): modal with a user autocomplete
  (`/api/users/lookup`), an "Everyone on this instance" switch, and the current share list with
  revoke buttons.
- Non-owner viewers see the intersection they're allowed to see; no edit affordances.

## 11.8. Scan sets (`/scan-sets`, `/scan-sets/:id`)

- List: name, status tag (Draft/Queued/Processing/Done/Failed), items count, result link when Done.
- **Builder** (detail in DRAFT/FAILED): name input, crop toggle ("Trim margins" default on),
  **orderable item strip** — thumbnails with drag-and-drop reorder and remove; "Add pages" opens a
  picker (documents grid filtered to images, multi-select, appends in selection order). Primary
  action **Merge into PDF** (requires ≥1 item) → status becomes Queued → live status via polling;
  Failed shows the error and keeps the builder editable; Done shows a success panel linking to the
  result document (which then behaves like any document: preview, OCR text, category, collections).
- Entry point besides the section: in the documents grid, multi-select mode (checkbox on hover) with
  a bulk action "Create scan set from selection" (images only; mixed selection → non-images are
  skipped with a notice).

## 11.9. Settings (`/settings`)

Profile card: display name, email (read-only), language (English/Русский), theme
(System/Light/Dark). Changes save immediately (`PATCH /api/me`), language switch re-renders instantly
(cookie + reload of messages).

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

## 11.12. Admin: Categories (`/admin/categories`)

Simple CRUD table: slug (immutable after create), name, description, documents count. Delete confirm
warns that documents will lose the category.

## 11.13. Admin: Queue (`/admin/queue`)

- **Overview cards:** per queue (scan / ingest / process / merge) — queued, active, failed-recent;
  plus pipeline totals (documents by step status) and S3 usage.
- **Failures table:** time, queue, payload summary (linked document/library), error (expandable),
  retry count, Retry button. Auto-refresh 5 s with a pause toggle.

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

- **Fraunces** — display: the wordmark, page titles, empty-state headlines. A variable serif with
  optical sizing; it gives the product a title-page voice instead of a dashboard voice.
- **IBM Plex Sans** — everything else. Humanist, slightly technical, legible at 13–14 px.
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
monogram — an "L" in Fraunces, not a truncated word.

## 11.16. Open questions

None.
