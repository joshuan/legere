-- Where a document is from, as something to browse by: `GET /api/documents?country=&city=` answers
-- "everything else from Podgorica" from the place printed in the viewer's own details pane
-- (docs/07 §7.3, docs/11 §11.5).
--
-- Partial, on `IS NOT NULL`: the place is read by the analysis step and most archives will hold
-- documents it never found one for, so an index over every row would be mostly NULL entries nothing
-- ever looks up. Both filters are equality on a non-null value, which is exactly what a partial
-- index serves.
--
-- Hand-written, and raw for two reasons: `prisma migrate dev` proposes dropping the raw-SQL indexes
-- it did not create (docs/04 §4.3), and Prisma's schema language cannot express a partial index at
-- all — `@@index` has no `WHERE`.
CREATE INDEX "documents_country_idx" ON "documents" ("country") WHERE "country" IS NOT NULL;
CREATE INDEX "documents_city_idx" ON "documents" ("city") WHERE "city" IS NOT NULL;
