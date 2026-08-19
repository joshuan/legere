---
name: prod-logs
description: Read the live Legere instance's application log or host health from the dev machine, read-only. Use when asked what production is logging, why a request failed, whether the instance is up or restarting, or to verify a deployed change's runtime behavior. Not for Stirling/Docling/AI-provider health — those are external services; read their outcomes from the database with the prod-db skill.
---

# Live instance: app log and host health

`scripts/ops/prod-logs.sh` answers "what is the app logging?" without an interactive shell on the
production host (docs/12 §12.8b). It is read-only by construction: each target is a fixed remote
command template, and nothing you pass reaches the remote command.

```
scripts/ops/prod-logs.sh app    [--since 30m] [--tail 500] [--grep 'error|warn']
scripts/ops/prod-logs.sh health
```

- `app` — the app container's stdout+stderr. Defaults: `--since 1h --tail 200`. `--since` takes a
  docker-style duration (`30s`, `45m`, `2h`, `1h30m`) or an ISO date/time; `--grep` is a
  case-insensitive ERE applied locally.
- `health` — one shot: container status (name, uptime, image), host `uptime`, `free -m`, `df -h /`.
  Start here when the question is "is it up / did it restart / is the host struggling".

## Reading the output

Lines are pino JSON, one object per line: `level` is numeric (30 info, 40 warn, 50 error),
`time` is epoch ms UTC. Request lines carry `req.method`, `req.url`, `res.statusCode`,
`responseTime`. Two deliberate blind spots (docs/06 §6.7): dynamic path segments are logged as
`:x` and query strings are dropped entirely, so a specific request is found by time + route shape

- status, not by its parameters; request bodies are never logged.

Useful patterns:

```
scripts/ops/prod-logs.sh app --since 2h --grep '"level":50'          # errors only
scripts/ops/prod-logs.sh app --since 15m --grep '/api/search'        # one route
scripts/ops/prod-logs.sh app --since 1h --tail 5000 | jq -r 'select(.res.statusCode>=500)'
```

## What is NOT in this log

Stirling, Docling, the embeddings/classifier providers and S3 are external services; this log only
shows the app's side of a call. Their failures land in the database — `documents.processing_error`,
`documents.failed_step`, `document_events` — which the **prod-db** skill reads.

## Setup (once per machine)

The script reads `~/.config/legere/ops.env` (override with `LEGERE_OPS_ENV`); copy
`scripts/ops/ops.env.example` there, fill in the ssh destination and container name, `chmod 600`.
Missing or incomplete config exits 2 with instructions. Never put these values in the repository —
it is public.
