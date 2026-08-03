-- What the pipeline decided, kept beside what the document now says: a person may correct the
-- category, the languages or the place, and the machine's own answer survives the correction, so the
-- viewer can show "read as X, corrected to Y" (docs/03 §3.3.10).
--
-- JSONB rather than five columns: these travel together, are only ever read as a whole, and none of
-- them is ever a filter or a join — the same reasoning as skip_reasons (docs/04 §4.3).
--
-- Hand-written, like every migration here: `prisma migrate dev` proposes dropping the raw-SQL search
-- indexes it did not create.
ALTER TABLE "documents" ADD COLUMN "auto_values" JSONB NOT NULL DEFAULT '{}';
