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

Milestones are strictly sequential; tasks within a milestone are ordered by dependency.
