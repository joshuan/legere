-- The shelf can be arranged: `GET /api/documents?sort=` takes a closed set of named orders
-- (docs/07 §7.1). Two of the three had nothing to read them from.
--
-- 1) "When did this document last change" — the newest entry in its journal, whatever kind
--    (docs/03 §3.3.18). Not `updated_at`: the pipeline bumps that whenever it rewrites a step
--    status, and two `$executeRaw` writes skip Prisma's stamping altogether, so it is an honest
--    "row touched" and a dishonest "edited". Ranking an archive by `max(document_events.at)` is a
--    correlated aggregate no index can serve, so the answer is denormalised onto the row and kept
--    by the one method every event is already written through (docs/03 §3.3.18).
--
--    Added nullable, backfilled, then made NOT NULL: a NOT NULL column with a volatile default
--    rewrites the table on the way in, and this instance is live (docs/04 §4.5). A document with no
--    journal at all falls back to `created_at` — the moment it came into being is the only honest
--    thing to say about when it last changed, and it keeps the column non-null, which keeps the
--    keyset predicate that reads it two-branch instead of three.
ALTER TABLE "documents" ADD COLUMN "last_event_at" TIMESTAMPTZ(6);

UPDATE "documents" d
   SET "last_event_at" = coalesce(
         (SELECT max(e."at") FROM "document_events" e WHERE e."document_id" = d."id"),
         d."created_at"
       );

ALTER TABLE "documents" ALTER COLUMN "last_event_at" SET NOT NULL;
ALTER TABLE "documents" ALTER COLUMN "last_event_at" SET DEFAULT now();

CREATE INDEX "documents_last_event_at_idx" ON "documents" ("last_event_at" DESC);

-- 2) The default order: the date written on the paper, newest first, with the undated *before*
--    everything rather than after — `ORDER BY document_date DESC NULLS FIRST, id DESC`.
--
--    `documents_document_date_idx` is `DESC NULLS LAST` and cannot be scanned backwards to produce
--    this: reversing it gives ASC NULLS FIRST, which is the wrong order among the dated rows. So
--    the two orders need two indexes, and the old one stays because browsing by year still reads
--    it (docs/04 §4.4).
--
--    `id DESC` is in the index rather than left to a sort: `document_date` is a DATE, so ties are
--    the common case — a hundred documents may carry the same day — and the keyset predicate needs
--    the tiebreak to continue a page inside one.
--
--    Hand-written, like every index here: `prisma migrate dev` proposes dropping the raw-SQL
--    indexes it did not create, and `@@index` cannot express NULLS FIRST at all (docs/04 §4.3).
CREATE INDEX "documents_document_date_nulls_first_idx"
  ON "documents" ("document_date" DESC NULLS FIRST, "id" DESC);
