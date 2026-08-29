#!/bin/sh
# PreToolUse hook: auto-allow shell commands that only touch the local dev
# database through a leading env-var prefix, e.g.
#   DATABASE_URL='postgresql://legere:legere@localhost:5432/legere_test_x?schema=public' npx vitest run ...
#   PGPASSWORD=legere psql -h localhost -U legere -d legere_test_x -c "\dt"
# Static permission rules cannot cover these: the test-database name changes
# per session, prefix rules only wildcard the TAIL of a command, and a rule
# that stops mid-URL would also allow `DATABASE_URL=x <anything>`.
#
# Decision: strip trusted VAR=value assignments, require the remainder to be
# one of the known dev-database commands, and require every host reference
# (DATABASE_URL, PGHOST, psql -h) to point at localhost. On match, print a
# PreToolUse allow decision; otherwise print nothing and let the normal
# permission flow ask the user.

cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# Single simple command only: no chaining, substitution, redirection or
# embedded newlines. Anything fancier falls back to the permission prompt.
if printf '%s' "$cmd" | grep -Eq '[;&|<>$`]'; then exit 0; fi
if [ "$(printf '%s' "$cmd" | wc -l)" -gt 0 ]; then exit 0; fi

# One or more trusted VAR=value prefixes, then a known dev-database command.
printf '%s' "$cmd" | grep -Eq "^((DATABASE_URL|PGPASSWORD|PGHOST|PGPORT|PGUSER|PGDATABASE|NODE_ENV|COMPOSE_PROJECT_NAME)=('[^']*'|\"[^\"]*\"|[^[:space:]]*)[[:space:]]+)+(npx[[:space:]]+(vitest|prisma)[[:space:]]|npm[[:space:]]+(test([[:space:]]|$)|run[[:space:]])|psql([[:space:]]|$))" || exit 0

# Every way of naming a host must resolve to the local machine.
if printf '%s' "$cmd" | grep -q 'DATABASE_URL='; then
  printf '%s' "$cmd" | grep -Eq "DATABASE_URL=[\"']?postgres(ql)?://[^@[:space:]]*@(localhost|127\.0\.0\.1):" || exit 0
fi
if printf '%s' "$cmd" | grep -Eq '(^|[[:space:]])PGHOST='; then
  printf '%s' "$cmd" | grep -Eq "(^|[[:space:]])PGHOST=[\"']?(localhost|127\.0\.0\.1)([\"'[:space:]]|$)" || exit 0
fi
if printf '%s' "$cmd" | grep -Eq '[[:space:]]-h([[:space:]]|=)'; then
  printf '%s' "$cmd" | grep -Eq "[[:space:]]-h[[:space:]=]+(localhost|127\.0\.0\.1)([[:space:]]|$)" || exit 0
fi

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"env-prefixed command against the local dev database"}}'
