#!/bin/sh
# The image is a complete deployment unit: every start first brings both database schemas to the
# version carried by the image, then starts the long-lived server. This lives in the image instead
# of docker-compose so `docker run`, Compose and automatic container updaters behave identically.
set -eu

printf '%s\n' 'legere: applying database migrations'
./node_modules/.bin/prisma migrate deploy

printf '%s\n' 'legere: applying queue migrations'
node dist/server/migrate-queue.js

printf '%s\n' 'legere: starting application command'
exec "$@"
