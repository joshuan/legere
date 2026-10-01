# 16. Design code — a clear working archive

Legere is a place to find, read and organize private documents and receipts. The interface should
make those objects easy to work with for hours. It is not a dashboard of decorative metrics.
This contract applies to every screen, both themes and every viewport from 320 px upward.

The shared foundations are maintained in `@joshuan/design-system` from js-lib, not in this
application. [Document 20](./20-ecosystem-design.md) records the coordinated UI-stack migration and
which contracts belong to the ecosystem. The archive-specific composition below remains local.

## 16.1. Direction and design review

Keep the recognizable green accent and the legible, self-hosted IBM Plex family. Replace simulated
paper, background grain, ornamental leaders and repeated framed cards with quiet neutral surfaces,
clear alignment and deliberate grouping. Document scans supply the visual variety.

The initial alternative was a general blue/grey application kit. It would be clean, but would lose
Legere's identity without making the archive easier to read. The chosen direction keeps the green,
gives documents the largest uninterrupted area, and expresses hierarchy through type and spacing.
No decorative statistics, introductory banners, gradients or animated card entrances.

```text
Desktop
┌────────────┬─────────────────────────────────────────────────────────┐
│ Legere     │ Screen title                    Secondary   Main action │
│            │ Filters / context                              View     │
│ Documents  ├─────────────────────────────────────────────────────────┤
│ Receipts   │                                                         │
│ Browse     │ Documents, table or reading workspace                   │
│ Search     │ using the full available width                          │
│ Collections│                                                         │
│ Catalogues │                                                         │
│ Admin      │                                                         │
│            │                                                         │
│ Account    │                                                         │
└────────────┴─────────────────────────────────────────────────────────┘

Phone
┌──────────────────────────┐
│ Menu     Legere          │   navigation opens over content
│ Screen title      Action │
│ Filters             View │
│                          │
│ Content at full width    │   no permanent icon rail
└──────────────────────────┘
```

Content is left aligned. Tables and archives use available width; a prose paragraph or an individual
form keeps a readable measure. Space is saved by hierarchy and disclosure, never by making text or
touch targets too small. Large displays may show supporting sections beside a form.

## 16.2. Foundations

| Role | Light | Dark |
|---|---|---|
| Canvas | `#F5F7F8` | `#121A1E` |
| Surface | `#FFFFFF` | `#1A252B` |
| Raised surface | `#FFFFFF` | `#223139` |
| Text | `#24323B` | `#E7EFF2` |
| Secondary text | `#5F7079` | `#A2B3BA` |
| Divider | `#DEE5E8` | `#30434B` |
| Control border | `#BCC9CF` | `#58707B` |
| Primary action | `#247463` | `#73C4AF` |

Semantic red, amber and green distinguish failure, caution and success. Status always includes
text or an icon; color is never the sole signal. The page and controls use theme tokens, including
overlays. A white document page is document content, not application chrome.
Light feedback surfaces use explicit pale tints (information `#F2F9F6`, success `#F1F9F3`,
warning `#FCF8EE`, failure `#FDF5F6`), with readable body text; do not derive their backgrounds
by lightening the dark accent with the component library's default palette generator.

- IBM Plex Sans: 14 px / 1.5 for controls and tables; 13 px for secondary metadata; 20–24 px / 1.3
  for screen headings; 16 px / 1.4 for section headings. Normal sentence case throughout.
- IBM Plex Mono only for paths, hashes, code and identifiers. Numeric columns use tabular figures
  in the body face. Body text uses lining figures rather than old-style numerals.
- Spacing: 4, 8, 12, 16, 20, 24, 32 px. Controls 40 px high on desktop; primary touch controls
  and icon hit areas at least 44 px on coarse pointers. No invisible 20 px collapse target.
- Corners: 6 px for controls, 8 px for content surfaces, 12 px for dialogs. Shadows belong to
  floating overlays, not every content block. Do not wrap a single already-framed table in a card.
- Focus: visible 2 px primary outline with 2 px offset. Hover changes color, never position.
  Motion answers interaction, lasts about 140 ms, and honors reduced-motion preferences.

## 16.3. Navigation, layout and scrolling

- Desktop navigation is a 240 px column, collapsible to 64 px. The menu alone scrolls if needed;
  identity and account controls stay visible. Selected route and its parent are apparent.
- Below 768 px navigation becomes a drawer, with a small mobile navigation row. Selecting a route
  closes the drawer; Escape closes it, focus returns to the trigger, and the background does not
  scroll while it is open. Tablet layouts may keep the collapsed rail.
- There is no global desktop header. Each screen owns one useful heading and its actions. The
  screen title is not repeated inside the first panel. Mobile chrome names the product only.
- Page gutters: 24 px on desktop, 16 px on tablet, 12 px on phones. No global maximum width.
  Use layout grids for related sections instead of stretching a one-field form across a monitor.
- Ordinary screens have one vertical page scroll. Do not put an entire ordinary screen into a
  second scrolling box. Tables may have their own horizontal region without widening the page.
- The desktop document workspace is the deliberate exception: its tabs remain visible, and the
  document and detail pane each scroll independently within the available viewport height. On
  narrow screens the title comes before the tabs and the workspace returns to ordinary page flow.
  Avoid a simultaneous outer vertical scrollbar.
- Scrollbars use browser-standard behavior and a quiet, visible thumb; never hide them to cover a
  layout defect. Sticky controls have an opaque surface and do not obscure focused content.

## 16.4. Toolbars, filters, views and selection

Use one primary action per scope. Actions name the result: Upload, Create collection, Save changes.
Primary actions sit at the end of the screen heading; contextual actions stay with their content.

Filtering and presentation are different tasks. Frequently used filters remain near the content;
advanced filters live behind a named Filters control, with an active count and a clear reset.
Keep the current sort visible beside Filters; grouping and visible card fields belong to a named
View control. Current choices continue
to live in the URL; clearing filters does not clear the chosen sort or layout. Popovers must fit a
320 px viewport and contain labelled fields. A field's placeholder is not its only label.

Selection mode has its own clear row with count, the available operation and Cancel. It does not
silently change what an ordinary card click does. Disabled operations retain an understandable
reason, and loading affects the submitting action without freezing unrelated navigation.

## 16.5. Forms and fields

- Labels above controls, descriptions below labels or below the field, errors directly below the
  affected field. Related fields align to one grid. Required/optional markers are consistent.
- Single-field forms have a readable width; two columns are reserved for closely related short
  fields when each remains at least 240 px wide. Stack them on narrow screens.
- Inputs, selects, date pickers and numbers share heights and borders. A filled value is visually
  distinct from placeholder text; disabled values remain readable. Textareas resize vertically.
- Phone date-range calendars open centered within the viewport, with months stacked and a bounded
  scroll region; all seven weekday columns remain visible.
- Read mode uses aligned labels and values with natural wrapping, not disabled form controls or
  dotted leaders. Long tokens wrap or have a dedicated horizontal code region.
- Keep Save and Cancel at the end of their form; a long dialog keeps these in its footer. Enter
  submits a single-line form; multiline inputs retain Enter. Do not submit a destructive action
  merely because focus arrives on a screen. Existing validation and authorization remain intact.
- Settings that save immediately clearly show the changed state and preserve error feedback.
  Editing one setting must not reset another field the user is editing.

## 16.6. Dialogs, drawers and tabs

- Dialog widths follow the job: approximately 440 px for a short confirmation, 560–640 px for a
  normal form, and a larger viewport-bounded workspace for page arrangement or cropping.
- Header, scrollable body and footer are separate. The title, close control and primary footer
  action remain available when content is tall. No double vertical scroll inside a normal form.
- At narrow widths the dialog uses the available width with 12 px margins. Its body respects
  dynamic viewport height. Focus enters the useful field, stays inside, and returns on close.
- Destructive confirmations name the affected object and the consequence, with Cancel available.
  Saving and failure states preserve the user's inputs. No implementation detail in product copy.
- Tabs switch peer views of the same object; they never act as form submit buttons. Use one
  underline treatment, 36–44 px navigation height, and no nested card chrome around the tab list.
  Long tab rows scroll within the row, keep the selected tab visible and support keyboard access.
- URL-backed tabs preserve direct links and Back behavior. Switching document tabs does not
  remount the archive-level loading skeleton or discard the document.

## 16.7. Screens and states

- Archive, browse and collections: document previews dominate; titles remain readable in two
  lines, metadata stays secondary, and grids adapt to the actual remaining content width.
- Receipts: readable vendor, date and total, with comparable amount alignment; source and
  extracted items remain distinct in the detail workspace.
- Search: one clear query field, adjacent submit action, optional filters grouped separately,
  and results with enough context to choose the right document.
- Catalogues and administration: aligned table headings and actions, compact rows, clear empty
  states, form dialogs that follow the same rules as document editing. Related settings and
  service details can use columns, without decorative metric-card grids.
- Account devices: show a readable browser and operating system; retain the full client string
  on hover and as a fallback for unrecognized clients.
- Login and registration: a restrained product identity and a focused form. No decorative hero
  content; errors, labels, code entry and progress are the visual priorities.
- Loading uses a stable shape; empty states explain the current scope and offer an available
  next action; errors preserve context and offer retry. A user who may upload a document should
  not be told that adding a library is the only way to begin.

## 16.8. Verification

Inspect representative populated, empty, error and editing states at 320, 390, 768, 1024 and
1440 px, in both themes and in English/Russian. Check keyboard focus, long labels and values,
dialog overflow, sticky controls and tab changes. Use synthetic local data, never production data.
Update visual baselines only in the pinned browser Docker environment, inspect the changed images,
and run the comparisons again without updating. Retain strict browser-error and overflow checks.
