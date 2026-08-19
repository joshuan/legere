#!/usr/bin/env bash
# Read-only SQL against a live Legere instance's database, as a dedicated read-only role
# (docs/12 §12.8b). Deployment-specific values come only from an env file outside the repository.
set -euo pipefail

OPS_ENV="${LEGERE_OPS_ENV:-$HOME/.config/legere/ops.env}"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/ops/prod-db.sh "<SQL>"          run one statement
       scripts/ops/prod-db.sh -f <file.sql>    run a file
       scripts/ops/prod-db.sh -                read SQL from stdin
Flags: --csv    CSV instead of the aligned table

The connection and credentials come from ~/.config/legere/ops.env (override with LEGERE_OPS_ENV);
see scripts/ops/ops.env.example. The configured role must be read-only by its own privileges.
EOF
  exit 2
}

fail() {
  echo "prod-db: $1" >&2
  exit 2
}

[[ -f "$OPS_ENV" ]] || fail "no config at $OPS_ENV — copy scripts/ops/ops.env.example there and fill it in"
set -a
# shellcheck source=/dev/null
source "$OPS_ENV"
set +a
for v in LEGERE_OPS_DB_HOST LEGERE_OPS_DB_NAME LEGERE_OPS_DB_USER LEGERE_OPS_DB_PASSWORD; do
  [[ -n "${!v:-}" ]] || fail "$OPS_ENV must set $v — see scripts/ops/ops.env.example"
done

CSV=""
MODE=""
SQL=""
FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --csv) CSV=1; shift ;;
    -f)
      [[ -n "${2:-}" && -z "$MODE" ]] || usage
      MODE=file
      FILE="$2"
      shift 2
      ;;
    -)
      [[ -z "$MODE" ]] || usage
      MODE=stdin
      shift
      ;;
    --help | -h) usage ;;
    *)
      [[ -z "$MODE" ]] || usage
      MODE=sql
      SQL="$1"
      shift
      ;;
  esac
done
[[ -n "$MODE" ]] || usage

# 🔒 The role's own privileges are the read-only guarantee; these two are the seat belt on top.
export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15s"
export PGPASSWORD="$LEGERE_OPS_DB_PASSWORD"
export PGCONNECT_TIMEOUT=10

ARGS=(--no-psqlrc -v ON_ERROR_STOP=1 -P pager=off
  -h "$LEGERE_OPS_DB_HOST" -p "${LEGERE_OPS_DB_PORT:-5432}"
  -U "$LEGERE_OPS_DB_USER" -d "$LEGERE_OPS_DB_NAME")
[[ -n "$CSV" ]] && ARGS+=(--csv)
case "$MODE" in
  sql) ARGS+=(-c "$SQL") ;;
  file) ARGS+=(-f "$FILE") ;;
  stdin) ;; # psql reads stdin when given neither -c nor -f
esac

exec psql "${ARGS[@]}"
