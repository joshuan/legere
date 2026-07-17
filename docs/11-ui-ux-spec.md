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
  admins.

## 11.4. Browse (`/browse/:libraryId?path=`)

Folder-tree navigation over the library's real directory structure (any nesting):
**Breadcrumb** (`Library name / sub / folder`), folder list (name + document count), then a document
grid of that folder (same cards as 11.3). Clicking a folder descends; breadcrumb ascends. Missing
files show as unavailable cards. This is the primary "explore what got mounted" scenario.

## 11.5. Document viewer (`/documents/:id`)

Two-pane layout:
- **Left (main): tabs** — `Preview` (canonical/source PDF in an `<object>`; for images the
  preview.jpg full-size; for text/markdown sources — rendered markdown), `Text` (rendered Markdown
  representation; empty state "No text extracted yet" / "Extraction failed"), `Details` (metadata
  table: size, pages, mime, hash (copyable), created, OCR used, file locations = visible FileRef
  paths with library names and MISSING badges, provenance for DERIVED docs — link to the scan set).
- **Right (sidebar):** title (inline-editable when permitted), category select (all users with
  access; shows "auto" tag when `categorySource=AUTO`), Download source button (disabled +
  tooltip when `UNAVAILABLE`), Add-to-collection select, processing status panel (5 steps with
  states; ADMIN sees a "Reprocess" button with step checkboxes and the `processingError` text on
  failure).

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

## 11.15. Open questions

None.
