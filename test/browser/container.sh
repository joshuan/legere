#!/usr/bin/env bash
set -euo pipefail
npm run db:migrate
npm run queue:migrate
# Run the installed CLI directly so its status and shutdown propagate without an npm wrapper.
exec node node_modules/@playwright/test/cli.js test "$@"
