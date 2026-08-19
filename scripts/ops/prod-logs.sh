#!/usr/bin/env bash
# Read-only observation of a live Legere instance: the app container's log and host health
# (docs/12 §12.8b). Deployment-specific values come only from an env file outside the repository.
set -euo pipefail

OPS_ENV="${LEGERE_OPS_ENV:-$HOME/.config/legere/ops.env}"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/ops/prod-logs.sh <target> [--since <duration|ISO date>] [--tail <n>] [--grep <ERE>]

Targets:
  app     the app container's log (pino JSON, one object per line; stdout + stderr)
  health  one-shot host summary: container status, uptime, memory, disk

Defaults: --since 1h, --tail 200. A duration is docker-style (30s, 45m, 2h, 1h30m).
--grep filters locally, case-insensitive.
Configuration: ~/.config/legere/ops.env (override with LEGERE_OPS_ENV); see scripts/ops/ops.env.example.
EOF
  exit 2
}

fail() {
  echo "prod-logs: $1" >&2
  exit 2
}

[[ -f "$OPS_ENV" ]] || fail "no config at $OPS_ENV — copy scripts/ops/ops.env.example there and fill it in"
set -a
# shellcheck source=/dev/null
source "$OPS_ENV"
set +a
[[ -n "${LEGERE_OPS_APP_SSH:-}" && -n "${LEGERE_OPS_APP_CONTAINER:-}" ]] ||
  fail "$OPS_ENV must set LEGERE_OPS_APP_SSH and LEGERE_OPS_APP_CONTAINER — see scripts/ops/ops.env.example"

[[ $# -ge 1 ]] || usage
TARGET="$1"
shift
SINCE=1h
TAIL=200
GREP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    --tail) TAIL="${2:-}"; shift 2 ;;
    --grep) GREP="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

# 🔒 Nothing caller-supplied reaches the remote command: these two are validated to a strict
# shape, --grep never leaves this machine, and the target picks a fixed template below.
[[ "$SINCE" =~ ^([0-9]+[smh])+$|^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$ ]] ||
  fail "--since must be a duration like 30s, 45m, 2h, 1h30m or an ISO date/time"
[[ "$TAIL" =~ ^[0-9]{1,6}$ ]] || fail "--tail must be a number"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=10 "$LEGERE_OPS_APP_SSH")

filter() {
  if [[ -n "$GREP" ]]; then
    grep -iE -- "$GREP" || true
  else
    cat
  fi
}

case "$TARGET" in
  app)
    "${SSH[@]}" "docker logs --since '$SINCE' --tail '$TAIL' '$LEGERE_OPS_APP_CONTAINER' 2>&1" | filter
    ;;
  health)
    "${SSH[@]}" "docker ps --filter name='$LEGERE_OPS_APP_CONTAINER' --format '{{.Names}}\t{{.Status}}\t{{.Image}}'; echo; uptime; echo; free -m; echo; df -h /"
    ;;
  *)
    usage
    ;;
esac
