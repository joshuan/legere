#!/bin/sh
# Converges the production database privileges after every migration (docs/12 §12.7).
# The owner credential exists only in this one-shot container; the application connects as
# `legere_app`, which can change rows in public and in pre-created pg-boss queues, but cannot change
# either schema or invoke pg-boss's DDL helpers itself.
set -eu

: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
: "${POSTGRES_APP_PASSWORD:?set POSTGRES_APP_PASSWORD}"
command -v psql >/dev/null 2>&1 || {
  printf '%s\n' 'postgres-runtime-role: psql is required' >&2
  exit 1
}

export PGPASSWORD="$POSTGRES_PASSWORD"

psql \
  --host="${POSTGRES_HOST:-db}" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="${POSTGRES_USER:-legere}" \
  --dbname="${POSTGRES_DB:-legere}" \
  --set=ON_ERROR_STOP=1 <<'SQL'
\getenv app_password POSTGRES_APP_PASSWORD

SELECT 'CREATE ROLE legere_app LOGIN'
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'legere_app') \gexec

-- Password rotation is convergent: changing the deployment secret takes effect on the next `up`.
SELECT format('ALTER ROLE legere_app LOGIN PASSWORD %L', :'app_password') \gexec
ALTER ROLE legere_app
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE legere_app SET statement_timeout = '30s';

-- A database is CONNECT-only to the runtime role. In particular it cannot create a schema and use
-- that as a way around the deliberately DML-only public schema.
SELECT format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM legere_app', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO legere_app', current_database()) \gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM legere_app;
GRANT USAGE ON SCHEMA public TO legere_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO legere_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO legere_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO legere_app;
-- Migration history is owner state, not application data. Letting a compromised server mark a
-- migration as applied would turn the next deploy into an inconsistent schema without needing DDL.
REVOKE ALL ON TABLE public._prisma_migrations FROM legere_app;

-- Migrations happen before this script on every deployment, so the ALL-object grants above cover
-- an upgrade immediately. Defaults also make the contract survive a table created manually by the
-- owner between deployments; the next run remains a second, idempotent backstop.
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO legere_app',
  current_user
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO legere_app',
  current_user
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO legere_app',
  current_user
) \gexec

-- The owner-only queue-migrate process has already migrated pg-boss and created every fixed queue
-- partition. Keep that schema and every object owned by the migrator so the *next* deployment can
-- migrate it too. Runtime receives row privileges only: no DDL helper can be turned into an
-- unbounded partition-creation or partition-drop primitive after process compromise.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION CURRENT_USER;

DO $ownership$
DECLARE
  object_name text;
  object_kind "char";
  owner_name text := current_user;
BEGIN
  FOR object_name, object_kind IN
    SELECT format('%I.%I', n.nspname, c.relname), c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
  LOOP
    CASE object_kind
      WHEN 'S' THEN EXECUTE format('ALTER SEQUENCE %s OWNER TO %I', object_name, owner_name);
      WHEN 'v' THEN EXECUTE format('ALTER VIEW %s OWNER TO %I', object_name, owner_name);
      WHEN 'm' THEN EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO %I', object_name, owner_name);
      WHEN 'f' THEN EXECUTE format('ALTER FOREIGN TABLE %s OWNER TO %I', object_name, owner_name);
      ELSE EXECUTE format('ALTER TABLE %s OWNER TO %I', object_name, owner_name);
    END CASE;
  END LOOP;

  FOR object_name IN
    SELECT p.oid::regprocedure::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pgboss'
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO %I', object_name, owner_name);
  END LOOP;

  FOR object_name, object_kind IN
    SELECT format('%I.%I', n.nspname, t.typname), t.typtype
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'pgboss' AND t.typtype IN ('e', 'd')
  LOOP
    IF object_kind = 'd' THEN
      EXECUTE format('ALTER DOMAIN %s OWNER TO %I', object_name, owner_name);
    ELSE
      EXECUTE format('ALTER TYPE %s OWNER TO %I', object_name, owner_name);
    END IF;
  END LOOP;
END
$ownership$;

SELECT format('ALTER SCHEMA pgboss OWNER TO %I', current_user) \gexec
REVOKE ALL ON SCHEMA pgboss FROM PUBLIC;
REVOKE ALL ON SCHEMA pgboss FROM legere_app;
GRANT USAGE ON SCHEMA pgboss TO legere_app;

REVOKE ALL ON ALL TABLES IN SCHEMA pgboss FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA pgboss FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA pgboss FROM legere_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO legere_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO legere_app;

-- Keep both DDL helpers owner-only and invoker-rights. The explicit reset makes this convergence,
-- not an assumption about how an earlier deployment happened to create the functions.
ALTER FUNCTION pgboss.create_queue(text, json) SECURITY INVOKER;
ALTER FUNCTION pgboss.create_queue(text, json) RESET ALL;
ALTER FUNCTION pgboss.delete_queue(text) SECURITY INVOKER;
ALTER FUNCTION pgboss.delete_queue(text) RESET ALL;

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
  current_user
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO legere_app',
  current_user
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO legere_app',
  current_user
) \gexec
SQL
