---
name: prod-db
description: Query the live Legere instance's PostgreSQL read-only from the dev machine. Use when asked what production data says — pipeline failures and their error messages, step timings, queue depth, document counts, settings — including the health of external services (Stirling, Docling, AI providers), which is read from the outcomes the pipeline recorded, not from their hosts.
---

# Live instance: read-only SQL

`scripts/ops/prod-db.sh` runs SQL against the live database as a dedicated role that is read-only
by its own PostgreSQL privileges (docs/12 §12.8b). Any write fails with a permission or read-only
error — that is expected and safe to rely on. Sessions carry a 15 s `statement_timeout`.

```
scripts/ops/prod-db.sh "select count(*) from documents where deleted_at is null"
scripts/ops/prod-db.sh --csv "select ..."     # machine-readable
scripts/ops/prod-db.sh -f query.sql           # or `-` for stdin
```

Ground rules: timestamps are **UTC**; rows are **soft-deleted** (`deleted_at is null` belongs in
almost every query); never `select *` from `documents` (huge `markdown`, `search_vector`) or
`document_chunks` (embedding vectors) — name the columns.

## Canned questions

**What is failing, and since when?** (external-service outages included — a Docling or provider
outage is legible here as its error message)

```sql
select failed_step, processing_error, count(*) as docs,
       min(updated_at) as first_seen, max(updated_at) as last_seen
from documents
where processing_error is not null and deleted_at is null
group by 1, 2 order by docs desc limit 20;
```

**Pipeline state at a glance** — per-step statuses are `canonical_status`, `preview_status`,
`markdown_status`, `analysis_status`, `fields_status`, `vectorization_status` (PENDING / QUEUED /
RUNNING / DONE / FAILED / SKIPPED):

```sql
select markdown_status, count(*) from documents
where deleted_at is null group by 1 order by 2 desc;
```

**How long steps take** — the journal records every step with its duration and the service it
called (`payload->>'step'`, `'service'`, `'durationMs'`, `'requestId'`):

```sql
select payload->>'step' as step, count(*) as runs,
       round(avg((payload->>'durationMs')::numeric)) as avg_ms,
       max((payload->>'durationMs')::numeric) as max_ms
from document_events
where at > now() - interval '24 hours' and payload ? 'durationMs'
group by 1 order by 1;
```

**Queue depth** (pg-boss):

```sql
select name, state, count(*) from pgboss.job group by 1, 2 order by 1, 2;
```

**Instance settings** (queue/gate configuration lives here, not only in env):

```sql
select key, value from settings;
```

## Setup (once per machine)

The script reads `~/.config/legere/ops.env` (override with `LEGERE_OPS_ENV`); copy
`scripts/ops/ops.env.example` there, fill in host/db/user/password of a **read-only** role
(e.g. one granted `pg_read_all_data` and nothing else — never the application's role),
`chmod 600`. Missing or incomplete config exits 2 with instructions. Never put these values in
the repository — it is public.
