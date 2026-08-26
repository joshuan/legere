-- The database says what `schema.prisma` says (docs/04 §4.1, docs/04 §4.2, docs/04 §4.3).
--
-- Migrations here are hand-written, so `prisma migrate diff` against the migrated database is the
-- only mechanical proof that the three artefacts — the documentation, the schema file and the live
-- tables — still describe one thing. That check is worthless while it is permanently non-empty, and
-- worse than worthless while its noise is indistinguishable from real drift: the same output mixed
-- four `DROP INDEX` lines that must never be run with seven that were merely undocumented. This
-- migration removes the seven. What is left is recorded in docs/04 §4.3 as the known residue.

-- 1) A constraint carrying the name of a column that no longer exists.
--
-- 20260804090000_category_becomes_type renamed `documents.category_id` to `type_id` and renamed the
-- two indexes over it, but a foreign key is not renamed by renaming its column: Postgres retargeted
-- the constraint silently and left it called `documents_category_id_fkey`. It enforces the right
-- rule under the wrong name, which is exactly the sort of thing that reads as drift the next time
-- somebody diffs the schema and has to work out, by hand, that it is not.
ALTER TABLE "documents" RENAME CONSTRAINT "documents_category_id_fkey" TO "documents_type_id_fkey";

-- 2) `updated_at` carries `DEFAULT now()` on every table that has one.
--
-- Five of the ten did already — `files`, `people`, `settings`, `subject_kinds` and `subjects`, whose
-- tables were written by hand — and five did not, because the Prisma-generated `init` does not emit
-- a default beside `@updatedAt`. Neither half was declared in `schema.prisma`, so the diff asked for
-- the five defaults to be dropped and said nothing about the other five. The rule is now one rule
-- and it is written down: Prisma sets the value on every create and update, and the database default
-- is what keeps a hand-written INSERT in some future migration from having to know that.
--
-- Catalogue-only: adding a default rewrites no row and changes no stored value.
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "libraries" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "documents" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "document_types" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "collections" ALTER COLUMN "updated_at" SET DEFAULT now();

-- 3) 🔒 A deleted user must not become "everybody".
--
-- `collection_shares.grantee_user_id` was created `ON DELETE SET NULL` — Prisma's default for an
-- optional relation, taken by default rather than chosen. But NULL in that column is not "grantee
-- unknown": it is the instance-wide share (docs/03 §3.3.15), the one row per collection that
-- `collection_shares_instance_active_uq` exists to keep singular. Hard-deleting a user would
-- therefore turn every unrevoked private grant they held on somebody else's collection into a grant
-- to the whole instance — and the resulting row would be indistinguishable from one the owner made.
--
-- `document_events.actor_id` carries the same shape and the same trap in the journal: NULL there is
-- "the pipeline acting on its own" (docs/03 §3.3.18), so the same DELETE would quietly reattribute
-- every action that person took to the machine.
--
-- No product code path hard-deletes a user — users are soft-deleted, and the RESTRICT edges from
-- `sessions`, `api_tokens`, `collections`, `library_access`, `password_resets` and
-- `user_invites.created_by_id` would refuse one today. That is the whole reason this was a landmine
-- and not a hole: it goes off the day somebody clears those out of the way, by hand or in a "purge
-- deactivated accounts" feature, and nothing about that DELETE looks like a widening of access. A
-- forward-only migration policy exists to defuse exactly this before it is somebody's incident.
--
-- Restrict rather than a `scope` discriminator: it is the smaller change, and both NULLs are read as
-- meaning by queries that already ship (docs/04 §4.2). Existing rows are unaffected — every value in
-- both columns is either NULL or points at a live user, so the constraints validate as they are
-- added and no row is rewritten.
ALTER TABLE "collection_shares" DROP CONSTRAINT "collection_shares_grantee_user_id_fkey";
ALTER TABLE "collection_shares" ADD CONSTRAINT "collection_shares_grantee_user_id_fkey"
  FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "document_events" DROP CONSTRAINT "document_events_actor_id_fkey";
ALTER TABLE "document_events" ADD CONSTRAINT "document_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
