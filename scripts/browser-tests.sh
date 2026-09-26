#!/usr/bin/env bash
# A private throwaway database and pinned Linux browser, including cleanup on test failure.
set -euo pipefail
cd "$(dirname "$0")/.."
project="legere-browser-$$"
compose=(docker compose -p "$project" -f test/browser/docker-compose.yaml)
cleanup() { "${compose[@]}" down --volumes --remove-orphans; }
trap cleanup EXIT
mkdir -p test/browser/__screenshots__ test-results playwright-report
# Keep output as pipes, including locally, so report completion does not depend on a TTY.
"${compose[@]}" run -T --build --rm browser "$@"
