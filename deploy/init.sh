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

# The same, without echoing what is typed: this one reads an SMTP password.
ask_secret() {
  local prompt="$1" answer=''
  if [ "$HAVE_TTY" = yes ]; then
    printf '%s' "$prompt" >/dev/tty
    IFS= read -rs answer </dev/tty || answer=''
    printf '\n' >/dev/tty
  fi
  printf '%s' "$answer"
}

# Sets one key in the .env just written, by string comparison rather than by sed: the values below
# are typed by a person, and `&`, `|` and a backslash all mean something in a sed replacement — a
# mail password containing one would land in the file mangled, and the failure would show up much
# later as "the server rejects our credentials". The temporary file is created private, because one
# of those values is that password.
set_env_value() {
  local key="$1" value="$2" line
  (
    umask 077
    : >.env.new
  )
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "${key}="*) printf '%s=%s\n' "$key" "$value" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <.env >>.env.new
  mv .env.new .env
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

# 🔒 Mail is not an optional extra. The six-digit code that creates the first administrator —
# and every account, verification and password reset after it — arrives by email and is written
# nowhere else: not to `docker compose logs`, not to a file. Asking here is the difference between
# a working install and a container that refuses to start and has to be diagnosed.
printf '\nMail. Legere emails the six-digit sign-up code, including the first administrator'"'"'s,\n'
printf 'and never writes it to the log. Leave the host empty to set this up later.\n\n'

smtp_host="${SMTP_HOST:-}"
if [ -z "$smtp_host" ]; then
  smtp_host=$(ask 'SMTP host, e.g. smtp.example.com []: ')
fi

smtp_port=465
smtp_user=''
smtp_password=''
smtp_from='Legere <no-reply@example.com>'
if [ -n "$smtp_host" ]; then
  smtp_port=$(ask 'SMTP port [465]: ')
  smtp_port="${smtp_port:-465}"
  smtp_user=$(ask 'SMTP username (blank = no authentication): ')
  if [ -n "$smtp_user" ]; then
    smtp_password=$(ask_secret 'SMTP password: ')
  fi
  smtp_from_answer=$(ask "From address [${smtp_from}]: ")
  smtp_from="${smtp_from_answer:-$smtp_from}"
fi

# 465 is implicit TLS and 587 is STARTTLS; mismatching the pair is the commonest mail failure there
# is, and the port is the half the operator actually knows.
#
# 🔒 465 is also the only one of the two that cannot be talked out of encrypting (SEC-62), which is
# why it is the default and why choosing the other one gets a paragraph rather than silence: what is
# in these letters is the six-digit code that creates, verifies and recovers every account.
smtp_secure=false
if [ "$smtp_port" = 465 ]; then
  smtp_secure=true
elif [ -n "$smtp_host" ]; then
  cat <<EOF

Note on port ${smtp_port}: TLS there is STARTTLS — the connection opens in the clear and is upgraded
only if ${smtp_host} offers the upgrade. Anyone on the path who removes that one line from the
greeting gets the relay password and every six-digit sign-up code in plaintext, and nothing fails
visibly. Port 465 is TLS from the first byte and cannot be downgraded; most providers offer it.
Change SMTP_PORT to 465 and SMTP_SECURE to true in .env to switch later.

EOF
fi

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

set_env_value SMTP_HOST "$smtp_host"
set_env_value SMTP_PORT "$smtp_port"
set_env_value SMTP_SECURE "$smtp_secure"
set_env_value SMTP_USER "$smtp_user"
set_env_value SMTP_PASSWORD "$smtp_password"
set_env_value SMTP_FROM "$smtp_from"

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

# 🔒 Nothing is started without mail, because nothing would work: the first administrator is created
# by typing a code that arrives in an inbox, and no other copy of it exists. Legere refuses to start
# in this state; saying so here is friendlier than a container restarting in a loop.
if [ -z "$smtp_host" ]; then
  cat <<EOF
Mail is not configured yet, and Legere will not start without it: the sign-up code of the first
administrator is emailed and written nowhere else — not to the log, not to a file.

  1. put SMTP_HOST (with SMTP_PORT / SMTP_USER / SMTP_PASSWORD / SMTP_FROM) in .env
  2. docker compose up -d

To run without mail anyway — an instance whose accounts already exist, a relay being repaired —
set ALLOW_UNCONFIGURED_EMAIL=true in .env. Nobody can sign up, verify an address or finish a
password reset on such an instance.

EOF
  exit 0
fi

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

Legere is starting. Open ${app_url} and create the first administrator.

The six-digit sign-up code is emailed to the address you type — it is never written to the log. If
it does not arrive, ${smtp_host} is where to look:

  docker compose logs app | grep -i smtp

EOF
