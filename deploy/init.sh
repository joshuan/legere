#!/usr/bin/env bash
# Sets up a Legere deployment in the current directory (docs/12 §12.7):
#
#   curl -fsSL https://raw.githubusercontent.com/joshuan/legere/main/deploy/init.sh | bash
#
# It fetches docker-compose.yaml, writes a .env with freshly generated secrets, and offers to start.
# Nothing is sent anywhere and nothing is installed outside this directory. Reading it before running
# it is the sensible habit: `curl -fsSL … -o init.sh && less init.sh && bash init.sh`.
set -euo pipefail

REF="${LEGERE_REF:-main}"
BASE_URL="${LEGERE_BASE_URL:-https://raw.githubusercontent.com/joshuan/legere/${REF}/deploy}"

die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

# The script itself is stdin when piped from curl, so questions have to come off the terminal. When
# there is no terminal at all — CI, a provisioning script — nothing is asked and defaults apply.
HAVE_TTY=no
if [ -e /dev/tty ] && { : </dev/tty; } 2>/dev/null; then HAVE_TTY=yes; fi

ask() {
  local prompt="$1" answer=''
  if [ "$HAVE_TTY" = yes ]; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -r answer </dev/tty || answer=''
  fi
  printf '%s' "$answer"
}

# Hex, not base64: this ends up inside a postgres:// URL, where a stray `/` or `+` would truncate it.
# The byte count is an argument because one of these secrets has a ceiling — see `random_hex 20`.
random_hex() {
  bytes=${1:-24}
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
  fi
}

command -v docker >/dev/null 2>&1 || die "docker is not installed — see https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (this is 'docker compose', not 'docker-compose')"
command -v curl >/dev/null 2>&1 || die "curl is not installed"

# 🔒 An existing .env holds the secrets of a running instance: overwriting it would lock the app out
# of its own database and bucket.
[ -e .env ] && die ".env already exists here — rerun in an empty directory, or edit it by hand"

printf 'Legere — setting up in %s\n\n' "$PWD"

library_path="${LIBRARY_PATH:-}"
if [ -z "$library_path" ]; then
  library_path=$(ask 'Folder with your documents [./documents]: ')
fi
# Empty answer = the default, so pressing Enter through the whole script is a working install.
library_path="${library_path:-./documents}"
library_path="${library_path/#\~/$HOME}"

if [ ! -d "$library_path" ]; then
  mkdir -p "$library_path" || die "could not create $library_path"
  printf 'Created %s — put documents there and Legere will pick them up on the next scan.\n' "$library_path"
fi
# `cd` resolves relative paths the way the operator meant them; compose needs an absolute one.
library_path=$(cd "$library_path" && pwd)

# Both the CSRF origin check and the presigned URLs are tied to the address people actually type, so
# guessing `localhost` for a box on the network gets a login that 403s and previews that never load.
host="${LEGERE_HOST:-}"
if [ -z "$host" ]; then
  host=$(ask 'Host or IP you will open Legere at [localhost]: ')
fi
host="${host:-localhost}"

port="${LEGERE_PORT:-}"
if [ -z "$port" ]; then
  port=$(ask 'Port for the web interface [3000]: ')
fi
port="${port:-3000}"

printf 'Fetching docker-compose.yaml…\n'
curl -fsSL "${BASE_URL}/docker-compose.yaml" -o docker-compose.yaml ||
  die "could not download docker-compose.yaml from ${BASE_URL}"

printf 'Writing .env with generated secrets…\n'
curl -fsSL "${BASE_URL}/.env.example" -o .env.tmp ||
  die "could not download .env.example from ${BASE_URL}"

sed \
  -e "s|^LIBRARY_PATH=.*|LIBRARY_PATH=${library_path}|" \
  -e "s|^APP_BASE_URL=.*|APP_BASE_URL=http://${host}:${port}|" \
  -e "s|^APP_PORT=.*|APP_PORT=${port}|" \
  -e "s|^S3_PUBLIC_ENDPOINT=.*|S3_PUBLIC_ENDPOINT=http://${host}:9000|" \
  -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(random_hex)|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(random_hex)|" \
  -e "s|^MINIO_ROOT_PASSWORD=.*|MINIO_ROOT_PASSWORD=$(random_hex)|" \
  `# 20 bytes, not 24: MinIO refuses a *service account* secret longer than 40 characters, and 24` \
  `# bytes of hex is 48. The root password above has no such ceiling, which is why this one is the` \
  `# only place it bites — and it bites hard: minio-init exits 1 and the app never starts, because` \
  `# it waits for that container to complete.` \
  -e "s|^MINIO_APP_PASSWORD=.*|MINIO_APP_PASSWORD=$(random_hex 20)|" \
  .env.tmp >.env
rm -f .env.tmp
chmod 600 .env

app_url=$(grep -E '^APP_BASE_URL=' .env | cut -d= -f2-)

cat <<EOF

Done. Two files are here:

  docker-compose.yaml   the stack: Legere, PostgreSQL, Stirling-PDF, MinIO
  .env                  your settings; the four secrets are generated, keep this file

Library:  ${library_path}  (read-only — Legere never writes there)
Address:  ${app_url}

Putting TLS in front of it later? Change APP_BASE_URL and S3_PUBLIC_ENDPOINT in .env to the https
addresses — the session cookie takes its Secure attribute from them.

EOF

# Starting containers is not something to do behind someone's back: without a terminal to ask, the
# script stops here and says what to run.
if [ "$HAVE_TTY" != yes ]; then
  printf 'Start it with:  docker compose up -d\n'
  exit 0
fi

start=$(ask 'Start it now? [Y/n] ')
case "$start" in
  [Nn]*)
    printf '\nWhen you are ready:  docker compose up -d\n'
    exit 0
    ;;
esac

docker compose up -d

cat <<EOF

Legere is starting. Open ${app_url} and create the first admin.

The six-digit sign-up code goes to the log until you configure SMTP:

  docker compose logs app | grep 'Legere code'

EOF
