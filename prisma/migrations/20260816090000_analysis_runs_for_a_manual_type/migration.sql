-- `MANUAL_TYPE` leaves the skip-reason set (docs/03 §3.3.10, docs/05 §5.5 step 4). A document whose
-- type a person chose is analysed rather than skipped: the confirmed type travels into the call as
-- a value the model is told, and the protection lives at the write — `type_id` and `type_source` are
-- simply not among the columns the step touches for such a document.
--
-- What the old skip left behind is a reason nobody may name any more, and the analysis it stood in
-- for: no date, no place, no people and no description, on exactly the documents somebody cared
-- enough about to type. So the reason goes and the step goes back to PENDING, for the hourly sweep
-- to walk through over the following hours (docs/05 §5.4) — the same arrival the typed-fields step
-- was given, and the reason `PENDING` means "nothing is scheduled" rather than "a worker is coming".
UPDATE "documents"
   SET "analysis_status" = 'PENDING',
       "skip_reasons"    = coalesce("skip_reasons", '{}'::jsonb) - 'analysis'
 WHERE "deleted_at" IS NULL
   AND "analysis_status" = 'SKIPPED'
   AND "skip_reasons"->>'analysis' = 'MANUAL_TYPE';

-- And wherever else the word is stored — a soft-deleted document, a step that has since settled
-- some other way — it goes without anything being re-run: nothing will analyse those, and a reason
-- outside the closed set reads as no reasons at all to the row that carries it, taking the reasons
-- of every other step of that document down with it.
UPDATE "documents"
   SET "skip_reasons" = coalesce("skip_reasons", '{}'::jsonb) - 'analysis'
 WHERE "skip_reasons"->>'analysis' = 'MANUAL_TYPE';
