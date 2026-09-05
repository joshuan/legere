# Task Execution Rules

How to work through [`backlog.md`](./backlog.md). These rules are binding for any agent (or human)
implementing Legere.

## The loop

1. Read [`../../CLAUDE.md`](../../CLAUDE.md) (golden rules) and [`../README.md`](../README.md)
   (documentation map) once per session.
2. Take the **first unchecked** task in `backlog.md`. Do not skip ahead, do not reorder, do not merge
   tasks. If a task looks wrong or blocked — stop and ask; do not silently work around it.
3. Read every document section the task references **before** writing code.
4. Create a branch `feat/mX-Y-<slug>` (or `fix/`, `chore/`, `ci/` as appropriate).
5. Implement strictly per the docs. Contract-first: if the task touches the API, write/extend the Zod
   schemas in `src/shared/contracts` first, then the server, then the client.
6. Write the tests the task's acceptance criteria demand (levels per
   [`14 §14.8`](../14-coding-standards.md#148-testing)).
7. Schema changed → forward-only Prisma migration committed with the task
   ([`04 §4.5`](../04-database-schema.md#45-migration-policy)).
8. `npm run typecheck && npm run lint && npm run test` — all green.
9. Tick the task checkbox (`[x]`) in `backlog.md` **in the same PR**; open the PR referencing the
   task ID; merge only on green CI ([ADR-014](../02-architecture-overview.md#adr-014-pull-request-based-development)).

## Definition of Done

The full checklist is [`14 §14.9`](../14-coding-standards.md#149-definition-of-done). Short form:
implements the docs exactly; tested; green; boundaries intact; no secrets/`any`/`as`/`!`; migration
included when the schema changed; checkbox ticked.

## Task format

Each backlog entry:

- **ID + title** — `M<milestone>.<number>`, checkbox tracks completion.
- **Goal** — what exists after the task that didn't before.
- **Docs** — the authoritative sections to implement.
- **Acceptance** — verifiable statements; treat them as the test checklist.

Acceptance criteria are the *minimum*; the referenced docs are the full truth. When a doc and a task
disagree, the doc wins — and report the discrepancy.

## Milestone map

| Milestone | Theme | Outcome |
|-----------|-------|---------|
| M0 | Foundations | one-process skeleton runs; CI green; image builds |
| M1 | Persistence | schema, migrations, seed, test DB harness |
| M2 | Auth & users | onboarding, login, invites, resets, sessions, admin users, auth UI |
| M3 | Libraries & scanning | libraries CRUD, queue, scan → FileRefs → Documents (dedup) |
| M4 | Processing pipeline | canonical PDF, previews, Markdown/OCR, document types, vectors, queue admin |
| M5 | Documents UX | documents/files/browse APIs, document types, grid, viewer, browse UI |
| M6 | Search | hybrid FTS + semantic search, search UI |
| M7 | Collections | collections, sharing, collections UI |
| M8 | Scan sets | merge-to-PDF flow end to end |
| M9 | Hardening & release | maintenance, mandatory-scenario audit, v0.1.0 |
| M10 | Correcting what the machine read | reading a field back, catalogues with screens of their own, a log that names the service |
| M11 | Uploading, throughput, recognition | an upload queue on the page, tunable concurrency, subjects the analysis can recognise |
| M12 | Reading the instance from outside | read-only API tokens |
| M13 | A file is not a document | a document is an ordered list of files plus one canonical PDF |
| M14 | Repairs and the operator's view | merges that hold, a queue that can be paused, an instance page |
| M15 | Closing what the audit found | the findings of [`security-audit-2026-08.md`](./security-audit-2026-08.md), fixed and tested |
| M16 | Reading the archive the way you keep it | two viewer defects; a home screen that can be sorted, arranged and grouped |
| M17 | A page that can be read | source-shaped pages, an uncapped analyst, step costs, selection and grouping that work |
| M18 | Reading what a camera saw | vision transcription, page correction, "half recognised" surfaced |
| M19 | Where an upload is watched | the upload panel; unsupported formats refused at the door |
| M20 | Work that waits for what it needs | step dependencies honoured; a gate per external service |
| M21 | The screen gives its height to the document | one strip of viewer chrome; the search overlay replaces the top bar |
| M22 | The paper knows its fields, and its neighbours | typed fields per document type; document links |
| M23 | The panel says where a service is, and whether it answers | external-service health, now surfaced on `/admin/processing/services` |
| M24 | The panel beside the document stops being a second screen | every viewer action moves to the tab that owns its subject |
| M25 | The pages come back in the order the paper meant | a per-file page order, obeyed by the canonical, arranged by hand |
| M26 | A loupe over the corner being dragged | pixel-accurate cropping on small screens |
| M27 | What a person confirmed, the machine believes | `MANUAL` values travel into every later model call as ground truth |
| M28 | The pane about the document, in three sections | what it says / what it is / what it cost |
| M29 | The pipeline grades its own work | 0–100 marks for legibility, extraction and field confidence |
| M30 | Schemas for the papers this archive actually holds | `flight`, `invoice`, `lab-report`, `civil-certificate`; `receipt`, `passport`, `id-card` revised |
| M31–M60 | Completed refinements and audit closure | see the authoritative ordered history in [`backlog.md`](./backlog.md) |
| M61 | One place to understand and control processing | one topology and control plane over queues, document steps and services, without merging their runtime semantics |

Milestones are strictly sequential; tasks within a milestone are ordered by dependency.

M15 is the exception to "take the first unchecked task": its tasks are ordered by what an attacker
reaches first, and three of them are blocked on a documentation decision (they say so). Take the
first unchecked task that is not blocked, and raise the blocked ones with the owner instead.
